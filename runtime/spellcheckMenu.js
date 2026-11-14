'use strict';

// Right-click menu for a misspelled word. Electron shows no menu of its own, so without
// this the red underline has no suggestions on any platform.
const MAX_SUGGESTIONS = 6;

function spellingMenuTemplate(props, { replace, addToDictionary } = {}) {
    const word = typeof props?.misspelledWord === 'string' ? props.misspelledWord.trim() : '';
    if (!word || !props.isEditable) return [];
    const suggestions = (Array.isArray(props.dictionarySuggestions) ? props.dictionarySuggestions : [])
        .filter(item => typeof item === 'string' && item.trim()).slice(0, MAX_SUGGESTIONS);
    return [
        ...(suggestions.length
            ? suggestions.map(suggestion => ({ label: suggestion, click: () => replace(suggestion) }))
            : [{ label: 'No suggestions', enabled: false }]),
        { type: 'separator' },
        { label: 'Add to dictionary', click: () => addToDictionary(word) }
    ];
}

module.exports = { spellingMenuTemplate, MAX_SUGGESTIONS };
