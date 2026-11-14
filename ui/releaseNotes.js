'use strict';

// Release notes in the update window. GitHub writes them in markdown, so this turns the parts the
// changelogs use into real elements. Everything is built node by node with text content, never HTML,
// and links only go to http(s) addresses, which the window-open policy hands to the browser.

const MAX_SOURCE = 128 * 1024;
const MAX_LINES = 4000;
const MAX_LINE = 8192;
const MAX_DEPTH = 6;

function webUrl(value) {
    if (typeof value !== 'string' || !/^https?:\/\//i.test(value) || /[\u0000- \u007f\\]/.test(value)) return '';
    try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) return '';
        return parsed.href;
    } catch (_) {
        return '';
    }
}

function link(document, url, children) {
    const anchor = document.createElement('a');
    anchor.className = 'upd-link';
    anchor.href = url;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    anchor.title = url;
    anchor.append(...children);
    return anchor;
}

const INLINE = [
    // \* and friends stay as the plain character.
    { pattern: /\\([\\`*_[\]()#+\-.!|~>{}])/y, build: (document, match) => document.createTextNode(match[1]) },
    { pattern: /(`+)([\s\S]+?)\1(?!`)/y, build: (document, match) => {
        const code = document.createElement('code');
        code.textContent = match[2].replace(/^ (.*) $/, '$1');
        return code;
    } },
    { link: true, pattern: /\[([^\]\n]{1,512})\]\(([^)\s]{1,2048})\)/y, build: (document, match, depth) => {
        const url = webUrl(match[2]);
        const label = inline(document, match[1], depth + 1, true);
        return url ? link(document, url, label) : label;
    } },
    { link: true, pattern: /<(https?:\/\/[^>\s]{1,2048})>/y, build: (document, match) => {
        const url = webUrl(match[1]);
        return url ? link(document, url, [document.createTextNode(match[1])]) : document.createTextNode(match[0]);
    } },
    { pattern: /\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/y, tag: 'strong' },
    { pattern: /(?<![A-Za-z0-9])__(?=\S)([\s\S]+?)(?<=\S)__(?![A-Za-z0-9])/y, tag: 'strong' },
    { pattern: /~~(?=\S)([\s\S]+?)(?<=\S)~~/y, tag: 'del' },
    // Italics can hold bold text (*see **Settings** first*), so a ** pair inside does not end them.
    { pattern: /\*(?=[^\s*])((?:\*\*(?=\S)[\s\S]+?(?<=\S)\*\*|[^*])+?)(?<!\s)\*(?!\*)/y, tag: 'em' },
    // snake_case and file_names stay as they are: underscores only count at word edges.
    { pattern: /(?<![A-Za-z0-9])_(?=[^\s_])([\s\S]+?)(?<=[^\s_])_(?![A-Za-z0-9])/y, tag: 'em' }
];
const BARE_URL = /https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"*_]/y;

function inline(document, text, depth = 0, insideLink = false) {
    const nodes = [];
    let plain = '';
    const flush = () => { if (plain) { nodes.push(document.createTextNode(plain)); plain = ''; } };
    if (depth > MAX_DEPTH) return [document.createTextNode(text)];
    let index = 0;
    while (index < text.length) {
        let built = null;
        for (const rule of INLINE) {
            if (insideLink && rule.link) continue;
            rule.pattern.lastIndex = index;
            const match = rule.pattern.exec(text);
            if (!match) continue;
            if (rule.tag) {
                const node = document.createElement(rule.tag);
                node.append(...inline(document, match[1], depth + 1, insideLink));
                built = { node, length: match[0].length };
            } else {
                const node = rule.build(document, match, depth);
                built = { node, length: match[0].length };
            }
            break;
        }
        if (!built && !insideLink && /[\s(]/.test(text[index - 1] || ' ')) {
            BARE_URL.lastIndex = index;
            const match = BARE_URL.exec(text);
            const url = match && webUrl(match[0]);
            if (url) built = { node: link(document, url, [document.createTextNode(match[0])]), length: match[0].length };
        }
        if (built) {
            flush();
            nodes.push(...(Array.isArray(built.node) ? built.node : [built.node]));
            index += built.length;
        } else {
            plain += text[index];
            index += 1;
        }
    }
    flush();
    return nodes;
}

function block(document, tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.append(...inline(document, text));
    return node;
}

function tableRow(document, line, cellTag) {
    const row = document.createElement('tr');
    const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).slice(0, 32);
    for (const cell of cells) row.append(block(document, cellTag, '', cell.trim()));
    return row;
}

function renderReleaseNotes(document, md) {
    const fragment = document.createDocumentFragment();
    const source = typeof md === 'string' ? md.slice(0, MAX_SOURCE) : '';
    if (!source.trim()) {
        const empty = document.createElement('p');
        empty.className = 'upd-empty';
        empty.textContent = 'No release notes were provided for this version.';
        fragment.append(empty);
        return fragment;
    }
    const lines = source.split(/\r?\n/).slice(0, MAX_LINES).map(line => line.slice(0, MAX_LINE));
    let paragraph = [];
    let list = null;
    const endParagraph = () => {
        if (paragraph.length) fragment.append(block(document, 'p', 'upd-p', paragraph.join(' ')));
        paragraph = [];
    };
    const endList = () => { list = null; };
    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const fence = /^\s*(```|~~~)/.exec(line);
        if (fence) {
            endParagraph(); endList();
            const body = [];
            while (++index < lines.length && !lines[index].trim().startsWith(fence[1])) body.push(lines[index]);
            const pre = document.createElement('pre');
            pre.className = 'upd-pre';
            const code = document.createElement('code');
            code.textContent = body.join('\n');
            pre.append(code);
            fragment.append(pre);
            continue;
        }
        if (!line.trim()) { endParagraph(); endList(); continue; }
        if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
            endParagraph(); endList();
            const rule = document.createElement('hr');
            rule.className = 'upd-hr';
            fragment.append(rule);
            continue;
        }
        const heading = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
        if (heading) {
            endParagraph(); endList();
            fragment.append(block(document, `h${Math.min(heading[1].length, 4)}`, 'upd-h', heading[2]));
            continue;
        }
        if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[index + 1] || '') && (lines[index + 1] || '').includes('-')) {
            endParagraph(); endList();
            const table = document.createElement('table');
            table.className = 'upd-table';
            const head = document.createElement('thead');
            head.append(tableRow(document, line, 'th'));
            const body = document.createElement('tbody');
            index += 1;
            while (index + 1 < lines.length && /^\s*\|.*\|\s*$/.test(lines[index + 1])) body.append(tableRow(document, lines[++index], 'td'));
            table.append(head, body);
            fragment.append(table);
            continue;
        }
        const item = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
        if (item) {
            endParagraph();
            const ordered = /\d/.test(item[2]);
            const tag = ordered ? 'ol' : 'ul';
            const makeList = () => {
                const node = document.createElement(tag);
                node.className = ordered ? 'upd-ol' : 'upd-ul';
                if (ordered) node.start = Number.parseInt(item[2], 10) || 1;
                return node;
            };
            const entry = block(document, 'li', '', item[3]);
            // One level of nesting: an indented item goes in a list inside the item above it.
            if (item[1].replace(/\t/g, '    ').length >= 2 && list && list.lastItem) {
                if (!list.sub || list.sub.tagName.toLowerCase() !== tag) {
                    list.sub = makeList();
                    list.lastItem.append(list.sub);
                }
                list.sub.append(entry);
                continue;
            }
            if (!list || list.node.tagName.toLowerCase() !== tag) {
                list = { node: makeList(), lastItem: null, sub: null };
                fragment.append(list.node);
            }
            list.node.append(entry);
            list.lastItem = entry;
            list.sub = null;
            continue;
        }
        const quote = /^\s{0,3}>\s?(.*)$/.exec(line);
        if (quote) {
            endParagraph(); endList();
            fragment.append(block(document, 'blockquote', 'upd-quote', quote[1]));
            continue;
        }
        if (list && /^\s{2,}\S/.test(line) && list.lastItem) {
            list.lastItem.append(document.createTextNode(' '), ...inline(document, line.trim()));
            continue;
        }
        endList();
        paragraph.push(line.trim());
    }
    endParagraph();
    return fragment;
}

module.exports = { renderReleaseNotes, webUrl };
