import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

export const DEFAULT_EMBED_ROOT_SELECTOR = "[data-synara-app-root]";

const DOCUMENT_ROOT_PSEUDOS = new Set([":root", ":host"]);
const DOCUMENT_ROOT_TAGS = new Set(["html", "body"]);

function isInsideKeyframes(rule) {
  for (let parent = rule.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && parent.name.toLowerCase().endsWith("keyframes")) {
      return true;
    }
  }
  return false;
}

function rootAttributeNode(rootSelector) {
  const firstNode = selectorParser().astSync(rootSelector).first?.first;
  if (!firstNode) throw new Error(`Invalid embedded CSS root selector: ${rootSelector}`);
  return firstNode.clone();
}

function scopeSelectorList(selectorList, rootSelector) {
  return selectorParser((selectors) => {
    selectors.each((selector) => {
      let replacedDocumentRoot = false;
      selector.walk((node) => {
        const documentRoot =
          (node.type === "pseudo" && DOCUMENT_ROOT_PSEUDOS.has(node.value)) ||
          (node.type === "tag" && DOCUMENT_ROOT_TAGS.has(node.value.toLowerCase())) ||
          (node.type === "id" && node.value === "root");
        if (!documentRoot) return;
        replacedDocumentRoot = true;
        node.replaceWith(rootAttributeNode(rootSelector));
      });

      if (replacedDocumentRoot) return;
      selector.prepend(selectorParser.combinator({ value: " " }));
      selector.prepend(rootAttributeNode(rootSelector));
    });
  }).processSync(selectorList);
}

export async function scopeEmbeddedCss(css, rootSelector = DEFAULT_EMBED_ROOT_SELECTOR) {
  const plugin = {
    postcssPlugin: "scope-synara-embedded-css",
    Once(root) {
      root.walkRules((rule) => {
        if (!rule.selector || isInsideKeyframes(rule)) return;
        rule.selector = scopeSelectorList(rule.selector, rootSelector);
      });
    },
  };

  return (await postcss([plugin]).process(css, { from: undefined })).css;
}
