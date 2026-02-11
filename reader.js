import './view.js'
import { createTOCView } from './ui/tree.js'
import { createMenu } from './ui/menu.js'
import { Overlayer } from './overlayer.js'
import * as TextWalkerModule from './text-walker.js'

const getCSS = ({ spacing, justify, hyphenate }) => `
    @namespace epub "http://www.idpf.org/2007/ops";
    html {
        color-scheme: light dark;
    }
    @media (prefers-color-scheme: dark) {
        a:link {
            color: lightblue;
        }
    }
    p, li, blockquote, dd {
        line-height: ${spacing};
        text-align: ${justify ? 'justify' : 'start'};
        -webkit-hyphens: ${hyphenate ? 'auto' : 'manual'};
        hyphens: ${hyphenate ? 'auto' : 'manual'};
        -webkit-hyphenate-limit-before: 3;
        -webkit-hyphenate-limit-after: 2;
        -webkit-hyphenate-limit-lines: 2;
        hanging-punctuation: allow-end last;
        widows: 2;
    }
    [align="left"] { text-align: left; }
    [align="right"] { text-align: right; }
    [align="center"] { text-align: center; }
    [align="justify"] { text-align: justify; }

    pre {
        white-space: pre-wrap !important;
    }
    aside[epub|type~="endnote"],
    aside[epub|type~="footnote"],
    aside[epub|type~="note"],
    aside[epub|type~="rearnote"] {
        display: none;
    }
`

const $ = document.querySelector.bind(document)

const locales = 'en'
const percentFormat = new Intl.NumberFormat(locales, { style: 'percent' })
const listFormat = new Intl.ListFormat(locales, { style: 'short', type: 'conjunction' })

const formatLanguageMap = x => {
    if (!x) return ''
    if (typeof x === 'string') return x
    const keys = Object.keys(x)
    return x[keys[0]]
}

const formatOneContributor = contributor => typeof contributor === 'string'
    ? contributor : formatLanguageMap(contributor?.name)

const formatContributor = contributor => Array.isArray(contributor)
    ? listFormat.format(contributor.map(formatOneContributor))
    : formatOneContributor(contributor)

class Reader {
    #tocView
    style = {
        spacing: 1.4,
        justify: true,
        hyphenate: true,
    }
    annotations = new Map()
    annotationsByValue = new Map()
    
    #ttsOverlayer = null
    #currentTtsRange = null
    #selectedVoiceURI = null
    #voiceMenu = null

    closeSideBar() {
        $('#dimming-overlay').classList.remove('show')
        $('#side-bar').classList.remove('show')
    }
    constructor() {
        $('#side-bar-button').addEventListener('click', () => {
            $('#dimming-overlay').classList.add('show')
            $('#side-bar').classList.add('show')
        })
        $('#dimming-overlay').addEventListener('click', () => this.closeSideBar())

        const menu = createMenu([
            {
                name: 'layout',
                label: 'Layout',
                type: 'radio',
                items: [
                    ['Paginated', 'paginated'],
                    ['Scrolled', 'scrolled'],
                ],
                onclick: value => {
                    this.view?.renderer.setAttribute('flow', value)
                },
            },
        ])
        menu.element.classList.add('menu')

        $('#menu-button').append(menu.element)
        $('#menu-button > button').addEventListener('click', () =>
            menu.element.classList.toggle('show'))
        menu.groups.layout.select('paginated')

        // --- Voices Menu ---
        this.#voiceMenu = createMenu([
            {
                name: 'voice',
                label: 'Voice',
                type: 'radio',
                items: [],
                onclick: value => {
                    this.#selectedVoiceURI = value;
                },
            },
        ])
        this.#voiceMenu.element.classList.add('menu')
        $('#voice-menu-button').append(this.#voiceMenu.element)
        $('#voice-menu-button > button').addEventListener('click', () =>
            this.#voiceMenu.element.classList.toggle('show'))

        const updateVoices = () => {
            const voices = window.speechSynthesis.getVoices();
            
            // Allowed names (Apple system voices and Google variants)
            const allowedPatterns = ['Daniel', 'Samantha', 'Ellen', 'Xander', 'Google'];
            const allowedLangs = ['en-GB', 'en-US', 'nl-NL', 'nl-BE'];

            // Step 1: Filter by language and desired names
            let filtered = voices.filter(v => 
                allowedLangs.some(lang => v.lang.includes(lang)) &&
                allowedPatterns.some(p => v.name.includes(p))
            );

            // Step 2: Sort by quality (Premium/Enhanced/Google > Compact)
            filtered.sort((a, b) => {
                const score = (v) => {
                    let s = 0;
                    if (v.name.includes('Premium') || v.name.includes('Enhanced')) s += 10;
                    if (v.name.includes('Google')) s += 5;
                    if (v.voiceURI.includes('compact')) s -= 10;
                    return s;
                };
                return score(b) - score(a);
            });

            // Step 3: Deduplication (Keep only the best version per name/language combination)
            const uniqueMap = new Map();
            filtered.forEach(v => {
                const baseIdentity = `${v.name.replace(/Compact|Premium|Enhanced/g, '').trim()}_${v.lang}`;
                if (!uniqueMap.has(baseIdentity)) {
                    uniqueMap.set(baseIdentity, v);
                }
            });

            const finalVoices = Array.from(uniqueMap.values());
            const items = finalVoices.map(v => [`${v.name} (${v.lang})`, v.voiceURI]);
            
            const list = this.#voiceMenu.element.querySelector('ul');
            if (list && items.length > 0) {
                list.innerHTML = '';
                items.forEach(([label, value]) => {
                    const li = document.createElement('li');
                    li.textContent = label;
                    li.dataset.value = value;
                    li.onclick = () => {
                        this.#selectedVoiceURI = value;
                        list.querySelectorAll('li').forEach(el => el.setAttribute('aria-checked', 'false'));
                        li.setAttribute('aria-checked', 'true');
                    };
                    li.setAttribute('aria-checked', this.#selectedVoiceURI === value ? 'true' : 'false');
                    list.appendChild(li);
                });
            }
        };

        window.speechSynthesis.onvoiceschanged = updateVoices;
        updateVoices();

        $('#tts-button')?.addEventListener('click', () => this.tts())
    }

    #autoSelectVoice(lang) {
        const voices = window.speechSynthesis.getVoices();
        const shortLang = lang ? lang.split('-')[0].toLowerCase() : 'nl';
        
        // Choose the best available voice (Google/Enhanced first) for the language
        const bestVoice = voices
            .filter(v => v.lang.startsWith(shortLang) && (v.name.includes('Google') || v.name.includes('Daniel') || v.name.includes('Samantha') || v.name.includes('Xander') || v.name.includes('Ellen')))
            .sort((a, b) => {
                const score = (v) => {
                    let s = 0;
                    if (v.name.includes('Premium') || v.name.includes('Enhanced')) s += 10;
                    if (v.name.includes('Google')) s += 5;
                    if (v.voiceURI.includes('compact')) s -= 10;
                    return s;
                };
                return score(b) - score(a);
            })[0];

        if (bestVoice) {
            this.#selectedVoiceURI = bestVoice.voiceURI;
            const list = this.#voiceMenu.element.querySelector('ul');
            if (list) {
                list.querySelectorAll('li').forEach(li => {
                    li.setAttribute('aria-checked', li.dataset.value === bestVoice.voiceURI ? 'true' : 'false');
                });
            }
        }
    }

    #lastLoadedDoc = null
    #lastLoadedIndex = null
    #currentVisibleRange = null
    
    tts() {
        const synth = window.speechSynthesis;
        const { TextWalker } = TextWalkerModule;

        if (synth.speaking) {
            synth.cancel();
            this.#clearTtsHighlight();
            return;
        }

        if (!TextWalker) return;

        const doc = this.#lastLoadedDoc;
        if (!doc || !doc.body) return;

        let range = null;
        try {
            const selection = doc.getSelection();
            if (selection && selection.rangeCount > 0 && !selection.getRangeAt(0).collapsed) {
                range = selection.getRangeAt(0);
            }
        } catch (e) {}

        if (!range && this.#currentVisibleRange) {
            try { range = this.#currentVisibleRange.cloneRange(); } catch (e) {}
        }

        if (!range) {
            try {
                const renderer = this.view?.renderer;
                if (renderer?.getVisibleRange) range = renderer.getVisibleRange();
            } catch (e) {}
        }

        if (!range) {
            try {
                const body = doc.body;
                range = doc.createRange();
                const visibleElements = body.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li');
                if (visibleElements.length > 0) {
                    range.setStartBefore(visibleElements[0]);
                    range.setEndAfter(visibleElements[Math.min(visibleElements.length - 1, 10)]);
                } else {
                    range.selectNodeContents(body);
                }
            } catch (e) { return; }
        }

        try {
            const walker = new TextWalker(range);
            const text = walker.getText(); 
            if (!text.trim()) return;

            const utterance = new SpeechSynthesisUtterance(text);
            
            if (this.#selectedVoiceURI) {
                const voice = synth.getVoices().find(v => v.voiceURI === this.#selectedVoiceURI);
                if (voice) utterance.voice = voice;
            } else {
                utterance.lang = this.view.book?.metadata?.language || 'nl-NL';
            }

            utterance.onboundary = (event) => {
                if (event.name === 'word') {
                    const wordRange = walker.getRange(event.charIndex, event.charIndex + event.charLength);
                    if (wordRange) this.#drawTtsHighlight(wordRange);
                }
            };

            utterance.onend = () => this.#clearTtsHighlight();
            utterance.onerror = () => this.#clearTtsHighlight();

            synth.speak(utterance);
        } catch (err) {
            console.error(err);
        }
    }

    #drawTtsHighlight(range) {
            this.#clearTtsHighlight();
            this.#currentTtsRange = range;
            const doc = this.#lastLoadedDoc;
            if (!doc) return;
            const textLayer = range.startContainer.parentElement?.closest('.textLayer');
            const isPDF = !!textLayer;
            try {
                if (!isPDF && this.view.renderer.emit) {
                    this.view.renderer.emit('create-overlayer', {
                        doc: this.#lastLoadedDoc,
                        index: this.#lastLoadedIndex,
                        attach: (overlayer) => {
                            this.#ttsOverlayer = overlayer;
                            overlayer.draw(Overlayer.highlight, {
                                range: this.#currentTtsRange,
                                color: 'rgba(255, 255, 0, 0.5)'
                            });
                        }
                    });
                    return;
                }
            } catch (e) {}
            try {
                const rects = range.getClientRects();
                if (rects.length === 0) return;
                const container = doc.createElement('div');
                container.id = 'tts-highlight';
                container.style.position = isPDF ? 'absolute' : 'fixed';
                container.style.top = '0';
                container.style.left = '0';
                container.style.pointerEvents = 'none';
                container.style.zIndex = '999999';
                const offsetRect = isPDF ? textLayer.getBoundingClientRect() : { left: 0, top: 0 };
                const pixelRatio = isPDF ? devicePixelRatio : 1;
                for (const rect of rects) {
                    const highlight = doc.createElement('div');
                    highlight.style.position = isPDF ? 'absolute' : 'fixed';
                    highlight.style.left = (isPDF ? (rect.left - offsetRect.left) * pixelRatio : rect.left) + 'px';
                    highlight.style.top = (isPDF ? (rect.top - offsetRect.top) * pixelRatio : rect.top) + 'px';
                    highlight.style.width = (rect.width * pixelRatio) + 'px';
                    highlight.style.height = (rect.height * pixelRatio) + 'px';
                    highlight.style.backgroundColor = 'rgba(255, 255, 0, 0.5)';
                    highlight.style.mixBlendMode = 'multiply';
                    highlight.style.borderRadius = '2px';
                    container.appendChild(highlight);
                }
                isPDF ? textLayer.appendChild(container) : doc.body.appendChild(container);
            } catch (e) {}
        }

    #clearTtsHighlight() {
        if (this.#ttsOverlayer) {
            try { this.#ttsOverlayer.element.remove(); } catch (e) {}
            this.#ttsOverlayer = null;
        }
        if (this.#lastLoadedDoc) {
            try { this.#lastLoadedDoc.getElementById('tts-highlight')?.remove(); } catch (e) {}
        }
        this.#currentTtsRange = null;
    }

    async open(file) {
        this.view = document.createElement('foliate-view')
        document.body.append(this.view)
        await this.view.open(file)
        this.view.addEventListener('load', this.#onLoad.bind(this))
        this.view.addEventListener('relocate', this.#onRelocate.bind(this))

        const { book } = this.view
        
        const bookLang = book.metadata?.language;
        if (bookLang) {
            this.#autoSelectVoice(bookLang);
        }

        book.transformTarget?.addEventListener('data', ({ detail }) => {
            detail.data = Promise.resolve(detail.data).catch(e => {
                console.error(new Error(`Failed to load ${detail.name}`, { cause: e }))
                return ''
            })
        })
        this.view.renderer.setStyles?.(getCSS(this.style))
        this.view.renderer.next()

        $('#header-bar').style.visibility = 'visible'
        $('#nav-bar').style.visibility = 'visible'
        $('#left-button').addEventListener('click', () => this.view.goLeft())
        $('#right-button').addEventListener('click', () => this.view.goRight())

        const slider = $('#progress-slider')
        slider.dir = book.dir
        slider.addEventListener('input', e =>
            this.view.goToFraction(parseFloat(e.target.value)))
        for (const fraction of this.view.getSectionFractions()) {
            const option = document.createElement('option')
            option.value = fraction
            $('#tick-marks').append(option)
        }

        document.addEventListener('keydown', this.#handleKeydown.bind(this))

        const title = formatLanguageMap(book.metadata?.title) || 'Untitled Book'
        document.title = title
        $('#side-bar-title').innerText = title
        $('#side-bar-author').innerText = formatContributor(book.metadata?.author)
        Promise.resolve(book.getCover?.())?.then(blob =>
            blob ? $('#side-bar-cover').src = URL.createObjectURL(blob) : null)

        const toc = book.toc
        if (toc) {
            this.#tocView = createTOCView(toc, href => {
                this.view.goTo(href).catch(e => console.error(e))
                this.closeSideBar()
            })
            $('#toc-view').append(this.#tocView.element)
        }

        const bookmarks = await book.getCalibreBookmarks?.()
        if (bookmarks) {
            const { fromCalibreHighlight } = await import('./epubcfi.js')
            for (const obj of bookmarks) {
                if (obj.type === 'highlight') {
                    const value = fromCalibreHighlight(obj)
                    const color = obj.style.which
                    const note = obj.notes
                    const annotation = { value, color, note }
                    const list = this.annotations.get(obj.spine_index)
                    if (list) list.push(annotation)
                    else this.annotations.set(obj.spine_index, [annotation])
                    this.annotationsByValue.set(value, annotation)
                }
            }
            this.view.addEventListener('create-overlay', e => {
                const { index } = e.detail
                const list = this.annotations.get(index)
                if (list) for (const annotation of list)
                    this.view.addAnnotation(annotation)
            })
            this.view.addEventListener('draw-annotation', e => {
                const { draw, annotation } = e.detail
                const { color } = annotation
                draw(Overlayer.highlight, { color })
            })
            this.view.addEventListener('show-annotation', e => {
                const annotation = this.annotationsByValue.get(e.detail.value)
                if (annotation.note) alert(annotation.note)
            })
        }
    }
    #handleKeydown(event) {
        const k = event.key
        if (k === 'ArrowLeft' || k === 'h') this.view.goLeft()
        else if(k === 'ArrowRight' || k === 'l') this.view.goRight()
    }
    #onLoad({ detail: { doc, index } }) {
        this.#lastLoadedDoc = doc
        this.#lastLoadedIndex = index
        doc.addEventListener('keydown', this.#handleKeydown.bind(this))
    }
    #onRelocate({ detail }) {
        const { fraction, location, tocItem, pageItem, range } = detail
        const percent = percentFormat.format(fraction)
        const loc = pageItem
            ? `Page ${pageItem.label}`
            : `Loc ${location.current}`
        const slider = $('#progress-slider')
        slider.style.visibility = 'visible'
        slider.value = fraction
        slider.title = `${percent} · ${loc}`
        if (tocItem?.href) this.#tocView?.setCurrentHref?.(tocItem.href)
        if (range) this.#currentVisibleRange = range
        window.speechSynthesis.cancel();
        this.#clearTtsHighlight();
    }
}

const open = async file => {
    if ($('#drop-target')) document.body.removeChild($('#drop-target'))
    const reader = new Reader()
    globalThis.reader = reader
    await reader.open(file)
}

const dragOverHandler = e => e.preventDefault()
const dropHandler = e => {
    e.preventDefault()
    const item = Array.from(e.dataTransfer.items).find(item => item.kind === 'file')
    if (item) {
        const entry = item.webkitGetAsEntry()
        open(entry.isFile ? item.getAsFile() : entry).catch(e => console.error(e))
    }
}
const dropTarget = $('#drop-target')
if (dropTarget) {
    dropTarget.addEventListener('drop', dropHandler)
    dropTarget.addEventListener('dragover', dragOverHandler)
}

$('#file-input').addEventListener('change', e =>
    open(e.target.files[0]).catch(e => console.error(e)))
$('#file-button').addEventListener('click', () => $('#file-input').click())

const params = new URLSearchParams(location.search)
const url = params.get('url')
if (url) open(url).catch(e => console.error(e))
else if (dropTarget) dropTarget.style.visibility = 'visible'
