// @flow @format
import ChromePromise from 'chrome-promise';
import cssbeautify from 'cssbeautify';
import io from 'socket.io-client';
import pdiff, { DimensionMismatchError, prefixURI } from './pdiff';
import { replacePropertyInStyleText } from './styleEdit';
import {
  serverToClient as outgoing,
  clientToServer as incoming,
} from './socket/messageTypes';
import normalizeNodes from './normalize';

import type { CRDP$HighlightConfig } from 'devtools-typed/domain/overlay';
import type { CRDP$BackendNodeId, CRDP$NodeId, CRDP$Node } from 'devtools-typed/domain/dom';
import type {
  CRDP$CSSStyle,
  CRDP$CSSRule,
  CRDP$CSSProperty,
  CRDP$RuleMatch,
} from 'devtools-typed/domain/css';

type Socket = Object;
type Target = {
  tabId: number,
};
type NodeMap = { [CRDP$NodeId]: CRDP$Node };
type CSSPropertyPath = {
  nodeId: CRDP$NodeId,
  ruleIndex: number,
  propIndex: number,
};
type DebugStatus = 'ACTIVE' | 'INACTIVE';

declare var chrome: Object;

const cp = new ChromePromise();
const PROTOCOL = '1.2';
const SOCKET_PORT = 1111;

// Highlighting for DOM overlays.
const NODE_HIGHLIGHT: CRDP$HighlightConfig = {
  contentColor: {
    r: 255,
    g: 0,
    b: 0,
    a: 0.3,
  },
  paddingColor: {
    r: 0,
    g: 255,
    b: 0,
    a: 0.3,
  },
  marginColor: {
    r: 0,
    g: 0,
    b: 255,
    a: 0.3,
  },
};

class BrowserEndpoint {
  socket: ?Socket;
  target: ?Target;
  document: ?CRDP$Node;
  nodes: NodeMap;
  styles: { [CRDP$NodeId]: MatchedStyles };
  inspectedNode: ?CRDP$Node;
  entities: { nodes: NormalizedNodeMap };
  ruleAnnotations: { [CRDP$NodeId]: Array<?CSSRuleAnnotation> };

  _debugEventDispatch: (Target, string, Object) => Promise<*>;

  constructor(port) {
    this.socket = io(`http://localhost:${port}/browsers`, {
      autoConnect: false,
      reconnectionAttempts: 5,
    });
    this.target = null;
    this.document = null;
    this.inspectedNode = null;
    this.styles = {};
    this.nodes = {};
    this.ruleAnnotations = {};

    // Bind `this` in the constructor, so we can
    // detach event handler by reference during cleanup.
    this._debugEventDispatch = this._debugEventDispatch.bind(this);
  }

  /**
   * Get the currently active tab in the focused Chrome
   * instance.
   */
  static async getActiveTab() {
    const tabs = await cp.tabs.query({
      active: true,
      currentWindow: true,
    });

    if (tabs.length === 0) {
      throw new Error('getActiveTab: no active tab found');
    } else {
      return tabs[0];
    }
  }

  /**
   * Prepare to receive requests for debugger data.
   */
  async initConnections(tabId) {
    // Mount debugger.
    await cp.debugger.attach({ tabId }, PROTOCOL);

    this.target = { tabId };
    chrome.debugger.onDetach.addListener(this._onDebuggerDetach.bind(this));
    chrome.debugger.onEvent.addListener(this._debugEventDispatch);
    await Promise.all([
      this._sendDebugCommand({
        method: 'Page.enable',
      }),
      this._sendDebugCommand({
        method: 'DOM.enable',
      }),
    ]);
    // These domains require DOM to be enabled first.
    await Promise.all([
      this._sendDebugCommand({
        method: 'CSS.enable',
      }),
      this._sendDebugCommand({
        method: 'Overlay.enable',
      }),
    ]);
    console.log('Attached debugger to target', this.target);

    // Once we have the DOM and are ready to handle
    // incoming requests, open the socket.
    if (this.socket && !this.socket.connected) {
      // Need to store the value of this.socket to
      // prevent Flow from invalidating the refinement.
      const { socket } = this;
      await new Promise(resolve => {
        socket.open();
        socket.on('disconnect', this._onSocketDisconnect.bind(this));
        socket.on('connect', () => {
          if (this.entities) {
            this._socketEmit(outgoing.SET_DOCUMENT, {
              entities: this.entities,
            });
          }
          if (this.styles) {
            this._socketEmit(outgoing.SET_STYLES, {
              styles: this.styles,
            });
          }
          if (this.inspectedNode) {
            this._socketEmit(outgoing.SET_INSPECTION_ROOT, {
              nodeId: this.inspectedNode.nodeId,
            });
          }
        });
        socket.on('connect', resolve);

        socket.on(incoming.PRUNE_NODE, this.pruneNode.bind(this));
        socket.on(incoming.CLEAR_HIGHLIGHT, this.clearHighlight.bind(this));
        socket.on(incoming.HIGHLIGHT_NODE, this.highlightNode.bind(this));
        socket.on(
          incoming.REQUEST_STYLE_FOR_NODE,
          this.requestStyleForNode.bind(this),
        );
        socket.on(
          incoming.TOGGLE_CSS_PROPERTY,
          this.toggleCSSProperty.bind(this),
        );
      });
      console.log('Opened socket', this.socket);
    } else {
      console.error('No socket found, could not setup connections');
    }

    this.updateIcon('ACTIVE');

    // Once debugger is mounted and sockets are open,
    // get the DOM and push it to the server.
    await this.getDocumentRoot();
    console.log('Retrieved document root', this.document);
  }

  /**
   * Updates the browser icon badge to indicate the status
   * of the debugging process.
   */
  updateIcon(status: DebugStatus) {
    const path = {
      ACTIVE: '../icons/icon-active-16.png',
      INACTIVE: '../icons/icon-inactive-16.png',
    }[status];

    // When status is active, this.target will be
    // an object containing the tabId of the debugging
    // target.
    // We only want to change the icon for the active tab.
    const options = Object.assign(
      {},
      { path },
      this.target && { tabId: this.target.tabId },
    );

    chrome.browserAction.setIcon(options);
  }

  /**
   * Set the root of the document.
   */
  async getDocumentRoot() {
    // Calling DOM.getDocument will invalidate all nodes.
    this.inspectedNode = null;
    this.styles = {};
    this.nodes = {};

    const { root } = await this._sendDebugCommand({
      method: 'DOM.getDocument',
      params: { depth: -1 },
    });

    // Set parentId value on every node.
    const withParents = this._addParentIds(-1)(root);
    this.document = withParents;

    const { entities } = normalizeNodes(withParents);
    this.entities = entities;
    this._socketEmit(outgoing.SET_DOCUMENT, {
      entities,
    });

    return withParents;
  }

  /**
   * Allow the user to select a node for focus.
   */
  async selectNode() {
    // Launch inspect mode.
    this._sendDebugCommand({
      method: 'Overlay.setInspectMode',
      params: {
        mode: 'searchForNode',
        highlightConfig: NODE_HIGHLIGHT,
      },
    });
  }

  /**
   * Highlight a node on the inspected page.
   * If argument is null, disable highlight.
   */
  async highlightNode({
    nodeId,
    selectorList,
  }: {
    nodeId: CRDP$NodeId,
    selectorList?: string,
  }) {
    let highlightConfig = NODE_HIGHLIGHT;

    if (selectorList) {
      highlightConfig = Object.assign({}, highlightConfig, { selectorList });
    }

    this._sendDebugCommand({
      method: 'DOM.highlightNode',
      params: {
        highlightConfig,
        nodeId,
      },
    });
  }

  async clearHighlight() {
    await this._sendDebugCommand({
      method: 'DOM.hideHighlight',
    });
  }

  /**
   * Set parentId on every node in a given tree.
   */
  _addParentIds(parentId) {
    return node => {
      const { children, nodeId } = node;
      let edit = { parentId };

      if (children && children.length) {
        edit = {
          parentId,
          children: children.map(this._addParentIds(nodeId)),
        };
      }

      // Cache the node in an object for faster indexing later.
      const nodeWithParent = Object.assign({}, node, edit);
      this.nodes[nodeId] = nodeWithParent;
      return nodeWithParent;
    };
  }

  /**
   * Get the nodeId of the first match for the specified selector.
   */
  async getNodeId(selector: string): Promise<CRDP$NodeId> {
    if (!this.document) {
      this.document = await this.getDocumentRoot();
    }

    let nodeId: NodeId;
    try {
      const response = await this._sendDebugCommand({
        method: 'DOM.querySelector',
        params: {
          selector,
          nodeId: this.document.nodeId,
        },
      });
      nodeId = response.nodeId;
    } catch (err) {
      throw err;
    }

    // Chrome Debugging Protocol returns nodeId of 0
    // if the node was not found.
    if (!nodeId) {
      throw new Error(`Couldn't retrieve nodeId for ${selector}`);
    }

    return nodeId;
  }

  async getNodeById(nodeId: CRDP$NodeId, offsetParent = false): Promise<CRDP$Node> {
    let result: CRDP$Node;

    if (this.nodes[nodeId]) {
      result = this.nodes[nodeId];
    } else {
      try {
        const searchResult = await this.searchDocument([nodeId]);
        result = searchResult[nodeId];
      } catch (err) {
        throw err;
      }
    }

    // Optionally also search for the node's offsetParent.
    if (offsetParent) {
      try {
        let offsetParentId: CRDP$NodeId = await this.getOffsetParentId(nodeId);
        let offsetParent: CRDP$Node = await this.getNodeById(offsetParentId);
        result.offsetParent = offsetParent;
      } catch (err) {
        console.error('Error retrieving offsetParent for node', nodeId);
      }
    }

    return result;
  }

  /**
   * Search breadth-first for a given set of nodes.
   */
  async searchDocument(wanted: CRDP$NodeId[]): Promise<NodeMap> {
    if (!this.document) {
      this.document = await this.getDocumentRoot();
    }

    const queue: CRDP$Node[] = [this.document];
    // NodeIds we are looking for, but haven't found.
    const missing: Set<CRDP$NodeId> = new Set(wanted);
    // Nodes we've found, associated with their nodeId.
    const found: NodeMap = {};

    while (queue.length > 0) {
      const node: CRDP$Node = queue.shift();
      const { nodeId } = node;

      if (missing.has(nodeId)) {
        found[nodeId] = node;
        missing.delete(nodeId);
      }

      // If `missing` is empty, we've found everything.
      if (missing.size === 0) {
        return found;
      }

      if (node.children) {
        queue.push(...node.children);
      }
    }

    /**
     * If search fails, return an Error object, which will be
     * checked by the caller and emitted back to the server.
     */
    const missingFormat: string = JSON.stringify(missing);
    throw new Error(`couldn't find nodes for ${missingFormat}`);
  }

  async requestStyleForNode({ nodeId }: { nodeId: CRDP$NodeId }) {
    const style = await this.getStyles(nodeId);
    this._socketEmit(outgoing.SET_STYLES, {
      styles: {
        [nodeId]: style,
      },
    });
  }

  /**
   * Get computed and matched styles for the given node.
   */
  async getStyles(nodeId: CRDP$NodeId): Promise<MatchedStyles> {
    let node: CRDP$Node;
    try {
      node = await this.getNodeById(nodeId);
    } catch (err) {
      throw err;
    }

    const { parentId } = node;

    const commands = [
      {
        method: 'CSS.getMatchedStylesForNode',
        params: { nodeId },
      },
      {
        method: 'CSS.getComputedStyleForNode',
        params: { nodeId },
      },
      {
        method: 'CSS.getComputedStyleForNode',
        params: { nodeId: parentId },
      },
    ];

    const commandPromises = commands.map(this._sendDebugCommand.bind(this));
    const [matchedStyles, ...computedStyles] = await Promise.all(
      commandPromises,
    );

    // Turn computed style arrays into ComputedStyleObjects.
    const [computedStyle, parentComputedStyle] = computedStyles
      // Extract the computed styles array from the response object.
      .map(({ computedStyle: cs }) =>
        cs.reduce(
          (memo, current) =>
            Object.assign(memo, { [current.name]: current.value }),
          {},
        ),
      );

    // Reverse the order of the matched styles, so that the
    // highest-specificity styles come first.
    matchedStyles.matchedCSSRules.reverse();

    // Get any rule annotations.
    const ruleAnnotations = this.ruleAnnotations[nodeId];

    const styles = Object.assign(
      {},
      matchedStyles,
      { computedStyle, parentComputedStyle },
      ruleAnnotations ? { ruleAnnotations } : null,
    );

    this.styles[nodeId] = styles;

    return styles;
  }

  captureScreenshot = async (nodeId?: CRDP$NodeId) => {
    const params = {};

    if (nodeId && typeof nodeId === 'number') {
      const [{ visualViewport }, { model }] = await Promise.all([
        this._sendDebugCommand({
          method: 'Page.getLayoutMetrics',
        }),
        this._sendDebugCommand({
          method: 'DOM.getBoxModel',
          params: { nodeId },
        }),
      ]);

      const { pageY } = visualViewport;
      const { border: [elX, elY], width, height } = model;
      const elViewport = {
        x: elX,
        y: pageY + elY,
        width,
        height,
        scale: 1,
      };

      params.clip = elViewport;
    }

    const { data } = await this._sendDebugCommand({
      method: 'Page.captureScreenshot',
      params,
    });

    // const url = 'data:image/png;base64,'.concat(data);
    // chrome.tabs.create({url});

    return data;
  };

  nodeInspected = async ({
    backendNodeId,
  }: {
    backendNodeId: CRDP$BackendNodeId,
  }) => {
    this.disableInspectMode();

    // Get the nodeId corresponding to the backendId.
    const [inspectedNodeId] = await this.pushNodesByBackendIdsToFrontend({
      backendNodeIds: [backendNodeId],
    });
    const node = await this.getNodeById(inspectedNodeId);
    const style = await this.getStyles(inspectedNodeId);
    this.inspectedNode = node;

    // Send resulting node to server.
    this._socketEmit(outgoing.SET_INSPECTION_ROOT, {
      nodeId: inspectedNodeId,
    });
    this._socketEmit(outgoing.SET_STYLES, {
      styles: { [inspectedNodeId]: style },
    });
    console.log(`Inspecting node ${inspectedNodeId}`, this.inspectedNode);
  };

  async pushNodesByBackendIdsToFrontend({
    backendNodeIds,
  }: {
    backendNodeIds: Array<CRDP$BackendNodeId>,
  }): Promise<Array<CRDP$NodeId>> {
    const { nodeIds } = await this._sendDebugCommand({
      method: 'DOM.pushNodesByBackendIdsToFrontend',
      params: {
        backendNodeIds,
      },
    });
    return nodeIds;
  }

  async disableInspectMode() {
    this._sendDebugCommand({
      method: 'Overlay.setInspectMode',
      params: { mode: 'none' },
    });
  }

  /**
   * Refresh stored styles, e.g. after a style edit has been made.
   */
  async refreshStyles(nodeId?: CRDP$NodeId): Promise<NodeStyleMap> {
    console.groupCollapsed('refreshStyles');
    const timerName = `Refreshing ${Object.keys(this.styles).length} styles:`;
    console.time(timerName);

    const nodesToUpdate: Array<NodeId> =
      typeof nodeId === 'number'
        ? [nodeId]
        : Object.keys(this.styles).map(str => parseInt(str, 10));

    // const storedNodeIds: NodeId[] = Object.keys(this.styles).map(nodeId =>
    //   parseInt(nodeId),
    // );

    if (nodesToUpdate.length) {
      console.time('awaiting updates');
      const updatedStyles = await Promise.all(
        nodesToUpdate.map(this.getStyles.bind(this)),
      );
      console.timeEnd('awaiting updates');
      console.log('finished updating styles:', Date.now());

      console.time('reducing style arrays');
      // Reduce the pair of arrays back into an object.
      for (let i = 0; i < updatedStyles.length; i += 1) {
        this.styles[nodesToUpdate[i]] = updatedStyles[i];
      }

      // this.styles = updatedStyles.reduce(
      //   (acc, currentStyle, i) =>
      //     Object.assign(acc, {
      //       [nodesToUpdate[i]]: currentStyle,
      //     }),
      //   {},
      // );
      console.timeEnd('reducing style arrays');
    } else {
      console.log('No styles currently stored');
    }
    console.timeEnd(timerName);
    console.groupEnd();
    return this.styles;
  }

  /**
   * Get the nodeId of the given node's offsetParent.
   */
  async getOffsetParentId(nodeId: CRDP$NodeId): Promise<CRDP$NodeId> {
    // Set the node in question to the "currently"
    // "inspected" node, so we can use $0 in our
    // evaluation.
    await this._sendDebugCommand({
      method: 'Overlay.setInspectedNode',
      params: { nodeId },
    });

    const { result } = await this._sendDebugCommand({
      method: 'Runtime.evaluate',
      params: {
        expression: '$0.parentNode',
        includeCommandLineAPI: true,
      },
    });

    const { objectId } = result;
    const offsetParentNode = await this._sendDebugCommand({
      method: 'DOM.requestNode',
      params: { objectId },
    });
    const offsetParentNodeId = offsetParentNode.nodeId;
    return offsetParentNodeId;
  }

  /**
   * Exposed handler, which toggles the style, updates the styles cache,
   * and responds with the updated styles.
   */
  async toggleStyleAndRefresh({
    nodeId,
    ruleIndex,
    propIndex,
  }: CSSPropertyPath): Promise<{
    [CRDP$NodeId]: MatchedStyles,
  }> {
    await this._toggleStyle(nodeId, ruleIndex, propIndex);
    return await this.refreshStyles();
  }

  async pushError({ error }: { error: string }) {
    this._socketEmit(outgoing.ERROR, { error });
  }

  async toggleCSSProperty({
    nodeId,
    ruleIdx,
    propIdx,
  }: {
    nodeId: CRDP$NodeId,
    ruleIdx: number,
    propIdx: number,
  }) {
    await this._toggleStyle(nodeId, ruleIdx, propIdx);
    const styles = await this.refreshStyles(nodeId);
    console.log('emitting styles:', Date.now());
    this._socketEmit(outgoing.SET_STYLES, {
      styles,
    });
  }

  async _toggleStyle(
    nodeId: CRDP$NodeId,
    ruleIndex: number,
    propIndex: number,
  ): Promise<> {
    const style: CRDP$CSSStyle = this.styles[nodeId].matchedCSSRules[ruleIndex].rule
      .style;
    const { range, styleSheetId, cssText: styleText } = style;
    const errorMsgRange = `node ${nodeId}, rule ${ruleIndex}, property ${propIndex}`;
    const property: CRDP$CSSProperty = style.cssProperties[propIndex];
    if (!property) {
      throw new Error(`Couldn't get property for ${errorMsgRange}`);
    }
    const currentPropertyText = property.text;
    if (!currentPropertyText) {
      throw new Error(`Couldn't get text for property ${errorMsgRange}`);
    }
    let nextPropertyText;
    const hasDisabledProperty = Object.prototype.hasOwnProperty.call(
      property,
      'disabled',
    );
    if (!hasDisabledProperty) {
      throw new Error(
        `Property ${errorMsgRange} appears to not be a source-based property`,
      );
    }
    const isDisabled = property.disabled;
    if (isDisabled) {
      // Need to re-enable it.
      // /* foo: bar; */ => foo: bar;
      // TODO: Fix bug with capturing regex.
      const disabledRegex = /\/\*\s+(.+)\s+\*\//;
      const matches = currentPropertyText.match(disabledRegex);

      if (!matches || !matches[1]) {
        throw new Error(
          `Property ${errorMsgRange} is marked as disabled, but disabled pattern was not found`,
        );
      }
      nextPropertyText = matches[1];
      if (!nextPropertyText) {
        throw new Error(
          `Couldn't find the original text in property ${currentPropertyText}`,
        );
      }
    } else {
      // Property is enabled, need to disable it.
      if (currentPropertyText.lastIndexOf('\n') === -1) {
        nextPropertyText = `/* ${currentPropertyText} */`;
      } else {
        // If a property is last in its rule, it may have a newline
        // at the end. Appending */ to the end would invalidate the
        // SourceRange for the rule.
        const noNewLineRegex = /.+(?=\n)/m;
        // $` gives the part before the matched substring
        // $& gives the match
        // $' gives the suffix
        const replacementString = "$`/* $& */$'";
        nextPropertyText = currentPropertyText.replace(
          noNewLineRegex,
          replacementString,
        );
      }
    }

    // Need to replace the current *style text* by searching for
    // the current *property text* within it, and replacing with
    // the updated *property text*.
    const currentStyleText = styleText;
    if (!currentStyleText) {
      throw new Error(
        `Couldn't get style text for node ${nodeId}, rule ${ruleIndex}`,
      );
    }
    const nextStyleText = replacePropertyInStyleText(
      style,
      property,
      nextPropertyText,
    );
    const edit = {
      styleSheetId,
      range,
      text: nextStyleText,
    };
    await this._sendDebugCommand({
      method: 'CSS.setStyleTexts',
      params: {
        edits: [edit],
      },
    });

    /**
     * Patch the locally-stored style.
     * Note that MULTIPLE style objects could be potentially stale,
     * and the caller needs to take care of refreshing the stored
     * styles and pushing an update to the server.
     * However, this monkeypatch will allow us to test an individual
     * toggling change more easily.
     */
    style.cssText = nextStyleText;
    property.text = nextPropertyText;
    property.disabled = !isDisabled;
  }

  isDisabled(path: CSSPropertyPath): boolean {
    let prop: ?CRDP$CSSProperty;
    try {
      prop = this.resolveProp(path);
    } catch (propNotFoundErr) {
      return false;
    }
    return !!prop.disabled;
  }

  /**
   * Longhand properties that are expansions of shorthand properties
   * will not have their own SourceRanges or property text.
   */
  isDeclaredProperty(path: CSSPropertyPath): boolean {
    let prop: ?CRDP$CSSProperty;
    try {
      prop = this.resolveProp(path);
    } catch (propNotFoundErr) {
      return false;
    }
    const hasText = !!prop.text;
    const hasRange = !!prop.range;
    return hasText && hasRange;
  }

  resolveProp(path: CSSPropertyPath): CRDP$CSSProperty {
    if (!this.propExists(path)) {
      throw new Error(
        `resolveProp: property ${path.nodeId}:${path.ruleIndex}:${path.propIndex} does not exist`,
      );
    }
    const { nodeId, ruleIndex, propIndex } = path;
    return this.styles[nodeId].matchedCSSRules[ruleIndex].rule.style
      .cssProperties[propIndex];
  }

  propExists({ nodeId, ruleIndex, propIndex }: CSSPropertyPath): boolean {
    const nodeStyles: MatchedStyles = this.styles[nodeId];
    if (!nodeStyles) {
      return false;
    }
    const ruleMatch: CRDP$RuleMatch = nodeStyles.matchedCSSRules[ruleIndex];
    if (!ruleMatch) {
      return false;
    }
    const prop: CRDP$CSSProperty = ruleMatch.rule.style.cssProperties[propIndex];
    if (!prop) {
      return false;
    }
    return true;
  }

  async pruneNode({ nodeId }: { nodeId: CRDP$NodeId }) {
    const _pruneNodeHelper = async (nodeId: CRDP$NodeId) => {
      await this.prune(nodeId);
      const currentNode = this.nodes[nodeId];
      if (currentNode.children) {
        const { children } = currentNode;
        for (const child of children) {
          await _pruneNodeHelper(child.nodeId);
        }
      }
    };

    let error;

    try {
      // await _pruneNodeHelper(nodeId);
      await this.prune(nodeId);
    } catch (pruneError) {
      error = {message: pruneError.message, stack: pruneError.stack};
    }

    const styles = await this.refreshStyles();
    this._socketEmit(outgoing.PRUNE_NODE_RESULT, { error });
    this._socketEmit(outgoing.SET_STYLES, {
      styles,
    });
  }

  /**
   * Prune properties for some node.
   */
  async prune(nodeId: CRDP$NodeId, condition?: CSSPropertyPath): Promise<> {
    console.groupCollapsed('Pruning node', nodeId);

    // Get current styles and screenshots for node.
    console.log('Getting initial styles...');
    const nodeStyles: MatchedStyles = await this.getStyles(nodeId);
    const { matchedCSSRules } = nodeStyles;
    const allPruned = [];

    let basePage;
    let baseElement;

    // If conditioning on a property, disable it first.
    if (condition) {
      ({
        page: basePage,
        el: baseElement,
      } = await this.getScreenshotForProperty(condition));
      await this.scrollIntoViewIfNeeded(nodeId);
    } else {
      basePage = await this.captureScreenshot();
      baseElement = await this.captureScreenshot(nodeId);
    }

    // Attach screenshots to the window for debugging.
    window.screenshots = [];
    window.screenshots.push({
      type: 'base',
      page: basePage,
      element: baseElement,
    });

    const pdiffOptions = { threshold: 0, maxDiff: 0 };
    const [pdiffAll, pdiffElement] = await Promise.all([
      pdiff(basePage, pdiffOptions),
      pdiff(baseElement, pdiffOptions),
    ]);

    const ruleAnnotations = [];
    const rules = matchedCSSRules.entries();

    for (const [ruleIndex, ruleMatch] of rules) {
      const { cssProperties } = ruleMatch.rule.style;
      let pruneResults = [];
      let ruleAnnotation = null;

      for (const [propIndex, prop] of cssProperties.entries()) {
        const propPath: CSSPropertyPath = {
          nodeId,
          ruleIndex,
          propIndex,
        };

        // Don't try to toggle if the property is a longhand expansion,
        // or if it's already disabled.
        if (!this.isDeclaredProperty(propPath)) {
          continue;
        }
        if (this.isDisabled(propPath)) {
          continue;
        }
        // Static VRP can't detect animation and interactive properties,
        // so don't prune these.
        if (prop.name === 'transition' || prop.name === 'cursor') {
          continue;
        }

        console.log(prop.name);

        await this.toggleStyleAndRefresh({ nodeId, ruleIndex, propIndex });

        const hasDiff = { element: false, page: false };
        const screenshotElement = await this.captureScreenshot(nodeId);
        window.screenshots.push({
          prop: prop.name,
          element: screenshotElement,
        });

        // First compute pdiff wrt the element itself. If removing the property
        // causes regression wrt the element, it trivially causes regression wrt
        // the page.
        try {
          const { numPixelsDifferent } = await pdiffElement(screenshotElement);
          if (numPixelsDifferent > 0) {
            hasDiff.element = true;
            hasDiff.page = true;
          }
        } catch (pdiffErr) {
          if (pdiffErr instanceof DimensionMismatchError) {
            // If disabling the property causes the element to change shape,
            // there is a clear visual regression.
            hasDiff.element = true;
            hasDiff.page = true;
          } else {
            // Log this error?
            console.error(pdiffErr);
          }
        }

        // Only need to compute the page-level pdiff if the element-level result
        // is zero.
        if (!hasDiff.element) {
          const screenshotPage = await this.captureScreenshot();
          window.screenshots[
            window.screenshots.length - 1
          ].page = screenshotPage;
          try {
            const { numPixelsDifferent } = await pdiffAll(screenshotPage);
            if (numPixelsDifferent > 0) {
              hasDiff.page = true;
            }
          } catch (pdiffErr) {
            if (pdiffErr instanceof DimensionMismatchError) {
              hasDiff.page = true;
            } else {
              console.error(pdiffErr);
            }
          }
        }

        // If there is a nonzero difference at either the element or page level,
        // the property is potentially relevant, so we need to reinstate it.
        if (hasDiff.element || hasDiff.page) {
          try {
            await this._toggleStyle(nodeId, ruleIndex, propIndex);
          } catch (toggleStyleError) {
            console.error(toggleStyleError);
          }
        }

        // If the current property has effects outside the current element,
        // mark the current rule as having a base style, and note
        // the property index.
        // TODO: Make this a separate function, annotateRule.
        // HACK: There are false positives with `margin-top`.
        // TODO: Investigate this and fix.
        if (!hasDiff.element && hasDiff.page && prop.name !== 'margin-top') {
          if (!ruleAnnotation) {
            ruleAnnotation = {
              type: 'BASE_STYLE',
              shadowedProperties: [propIndex],
            };
          } else {
            ruleAnnotation.shadowedProperties.push(propIndex);
          }
        }

        // Log the differences recorded.
        pruneResults.push(
          Object.assign({}, hasDiff, {
            prop: prop.name,
          }),
        );
      }

      // At the end of the rule, add the list of prune results to an object.
      allPruned.push([ruleMatch.rule.selectorList.text, pruneResults]);

      // TODO: This assumes the number and order of rules never
      // changes between style refreshes. Need to change this to
      // something less brittle if we ever add the ability to
      // insert/delete/move rules around within the cascade.
      ruleAnnotations.push(ruleAnnotation);
    }

    // Done pruning all rules in style.
    // Mark the rules pruned in source.
    // TODO: Figure out some way to invalidate this later?
    // eslint-disable-next-line no-unused-vars
    for (const rule of matchedCSSRules) {
      await this.markRulePruned(rule);
    }

    console.log('allPruned', allPruned);
    console.log(
     'page not self',
     allPruned
       .map(([selector, props]) => [
         selector,
         props.filter(({ element, page }) => !element && page),
       ])
       .filter(([, specialProps]) => specialProps.length > 0),
   );
    console.groupEnd();
  }

  async markRulePruned(rule: CRDP$CSSRule) {
    const {style, styleSheetId, origin} = rule;
    const {cssText, range} = style;

    if (origin !== 'regular' || !cssText) {
      throw new Error(`Cannot edit range for rule with origin ${origin}`);
    }

    if (cssText && !cssText.match(/^\/\*\* PRUNED \*\//)) {
      // No need to double-mark.
      return;
    }

    const PRUNED_PREFIX = '/** PRUNED */';
    const nextStyleText = `${PRUNED_PREFIX}${cssText}`
    const edit = {
      styleSheetId,
      range,
      text: nextStyleText,
    };

    await this._sendDebugCommand({
      method: 'CSS.setStyleTexts',
      params: {
        edits: [edit],
      }
    });

    // TODO: Need to call this?
    // this.refreshStyles(nodeId);
  }

  async scrollIntoViewIfNeeded(nodeId: CRDP$NodeId): Promise<> {
    const { model } = await this._sendDebugCommand({
      method: 'DOM.getBoxModel',
      params: { nodeId },
    });
    const { border, content, height, width } = model;
    const [x, y] = border || content;
    const { visualViewport } = await this._sendDebugCommand({
      method: 'Page.getLayoutMetrics',
    });
    const { clientHeight, clientWidth, pageX, pageY } = visualViewport;

    const page = {
      x: { start: pageX, end: pageX + clientWidth },
      y: { start: pageY, end: pageY + clientHeight },
    };
    const el = {
      x: { start: x, end: x + width },
      y: { start: y, end: y + height },
    };

    // Check whether element is small enough to view entirely.
    const elementTooWide = width > clientWidth;
    const elementTooTall = height > clientHeight;
    const elementTooLarge = elementTooWide || elementTooTall;
    const isVisibleX = page.x.start <= el.x.start && el.x.start <= page.x.end;
    const isVisibleY = page.y.start <= el.y.start && el.y.start <= page.y.end;

    // TODO: Don't scroll page if element is too large, and at all in view.
    const isVisible = elementTooLarge || (isVisibleX && isVisibleY);

    if (!isVisible) {
      // Scroll entire element into view.
      return await this._sendDebugCommand({
        method: 'Runtime.evaluate',
        params: {
          expression: `window.scrollTo(document.documentElement.scrollLeft + ${x}, document.documentElement.scrollTop + ${y})`,
        },
      });
    }
  }

  async getScreenshotForProperty({
    nodeId,
    ruleIndex,
    propIndex,
  }: CSSPropertyPath): Promise<{ page: string, el: string }> {
    // TODO: Deprecate this function.
    await this.toggleStyleAndRefresh({ nodeId, ruleIndex, propIndex });

    // Can't do these in parallel because of viewport resize.
    const page = await this.captureScreenshot();
    const el = await this.captureScreenshot(nodeId);

    const result = {
      page,
      el,
    };
    return result;
  }

  /**
   * Handle certain events from the debugger.
   */
  _debugEventDispatch(target: Target, method: string, params: Object) {
    const dispatch = {
      /**
       * When new stylesheets are added, reformat the text so that
       * each property is on its own line.
       *
       * This will make it easier to disable/re-enable without
       * messing up the SourceRanges of all other properties.
       */
      'CSS.styleSheetAdded': async ({ header }) => {
        const { styleSheetId } = header;
        const { text } = await window.endpoint._sendDebugCommand({
          method: 'CSS.getStyleSheetText',
          params: {
            styleSheetId,
          },
        });
        const formattedText = cssbeautify(text);
        this._sendDebugCommand({
          method: 'CSS.setStyleSheetText',
          params: {
            styleSheetId,
            text: formattedText,
          },
        });
      },
      /**
       * Fired when the document is updated and NodeIds
       * are no longer valid.
       */
      'DOM.documentUpdated': async () => {
        console.log('%cdocument updated', 'color: green; font-weight: bold;');
        this.getDocumentRoot();
        this.refreshStyles();
      },
      /**
       * Fired when a node is inspected after calling DOM.setInspectMode.
       * Sets this.inspectedNode to the NodeId of the clicked element.
       */
      'Overlay.inspectNodeRequested': this.nodeInspected,

      /**
       * Clean up when we refresh page.
       */
      'Page.loadEventFired': this.cleanup,
    };

    const action = dispatch[method];

    if (action) {
      action(params);
    }
  }

  /**
   * Emit data over the socket.
   */
  _socketEmit(message: IncomingMessage, data?: Object) {
    if (this.socket && this.socket.connected) {
      this.socket.emit(message, data);
      console.log(`Emitting ${message} to server`, data);
    } else {
      console.error(`No socket connection, couldn't emit message`, data);
    }
  }

  /**
   * Dispatch a command to the chrome.debugger API.
   */
  async _sendDebugCommand({ method, params }: { method: string, params?: Object }) {
    // Highlighting will get called frequently and clog the console.
    if (method !== 'DOM.highlightNode' && method !== 'DOM.hideHighlight') {
      console.log(
        `%c${method}`,
        'color: grey; font-weight: light;',
        params,
        this.target,
      );
    }
    return await cp.debugger.sendCommand(this.target, method, params);
  }

  /**
   * Clean up socket connection and properties.
   */
  async cleanup() {
    if (this.socket && this.socket.connected) {
      this.socket.close();
    }
    if (this.target) {
      chrome.debugger.onEvent.removeListener(this._debugEventDispatch);
      await cp.debugger.detach(this.target);
    }
    if (window.endpoint) {
      delete window.endpoint;
    }
  }

  _onSocketDisconnect() {
    if (this.socket) {
      // this.socket.off();
      // this.socket = null;
    }
    console.log('Disconnected from socket');
    // this.cleanup();
  }

  _onDebuggerDetach() {
    if (this.target) {
      this.updateIcon('INACTIVE');
      this.target = null;
      this.document = null;
      console.log('Detached from debugging target');
    }
    this.cleanup();
  }
}

async function main() {
  if (!window.endpoint) {
    const endpoint = new BrowserEndpoint(SOCKET_PORT);
    window.endpoint = endpoint;
  }

  const { id: tabId } = await BrowserEndpoint.getActiveTab();
  const hasConnection =
    window.endpoint.target && window.endpoint.target.tabId === tabId;

  if (!hasConnection) {
    // Need to init connections.
    await window.endpoint.initConnections(tabId);
  }

  /**
   * Invoke node selection, now that we are guaranteed
   * to have an active endpoint attached to current tab.
   */
  window.endpoint.selectNode();
}

// // HACK: Bind the test menu item.
// chrome.contextMenus.create({
//   title: 'Test pruning',
//   contexts: ['browser_action'],
//   onclick: testPruning,
// });

window.open = uri => chrome.tabs.create({ url: prefixURI(uri) });

chrome.browserAction.onClicked.addListener(main);
