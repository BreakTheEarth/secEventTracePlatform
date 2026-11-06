import sanitizeHtml from 'sanitize-html';

export const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function cleanRichText(value, { campaignAssets = false } = {}) {
  const cleaned = sanitizeHtml(String(value || ''), {
    allowedTags: [
      'p', 'br', 'strong', 'b', 'em', 'i', 'u', 's', 'h2', 'h3', 'ul', 'ol',
      'li', 'blockquote', 'pre', 'code', 'hr', 'table', 'thead', 'tbody',
      'tr', 'th', 'td', 'a', 'div', 'img',
    ],
    allowedAttributes: {
      a: ['href', 'target', 'rel'],
      img: ['src', 'alt'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesByTag: { img: [] },
    allowProtocolRelative: false,
    disallowedTagsMode: 'discard',
    parser: { lowerCaseTags: true },
    transformTags: {
      a: (tagName, attribs) => {
        const href = attribs.href || '';
        const local = /^\/api\/event-assets\/[1-9][0-9]*\/download$/.test(href) || (campaignAssets && /^\/api\/campaign-assets\/[1-9][0-9]*\/download$/.test(href));
        return {
          tagName,
          attribs: local || /^(?:https?:|mailto:)/i.test(href)
            ? { href, target: '_blank', rel: 'noopener noreferrer' } : {},
        };
      },
      img: (tagName, attribs) => ({
        tagName,
        attribs: (campaignAssets ? /^\/api\/campaign-assets\/[1-9][0-9]*\/download$/ : /^\/api\/event-assets\/[1-9][0-9]*\/download$/).test(attribs.src || '')
          ? { src: attribs.src, alt: String(attribs.alt || '事件图片').slice(0, 120) } : {},
      }),
    },
    exclusiveFilter: frame => frame.tag === 'img' && !frame.attribs.src,
  });
  return cleaned.replace(/<(br|hr|img)([^>]*)>/gi, (_, tag, attributes) =>
    `<${tag}${attributes.trimEnd().replace(/\s*\/$/, '')}>`);
}
