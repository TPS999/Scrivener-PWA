import { Mark, mergeAttributes } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import TextAlign from '@tiptap/extension-text-align';
import Highlight from '@tiptap/extension-highlight';
import Placeholder from '@tiptap/extension-placeholder';

/** Scrivener linked comment or footnote, anchored to a span of text. */
export const ScrivComment = Mark.create({
  name: 'scrivComment',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return {
      id: { default: null, parseHTML: (el) => el.getAttribute('data-id') },
      kind: { default: 'comment', parseHTML: (el) => el.getAttribute('data-kind') },
      text: { default: '', parseHTML: (el) => el.getAttribute('data-text') ?? '' },
    };
  },
  parseHTML() { return [{ tag: 'span[data-scriv-comment]' }]; },
  renderHTML({ HTMLAttributes }) {
    const { id, kind, text, ...rest } = HTMLAttributes as Record<string, string>;
    return ['span', mergeAttributes(rest, {
      'data-scriv-comment': '', 'data-id': id, 'data-kind': kind, 'data-text': text,
      class: kind === 'footnote' ? 'fn-anchor' : 'cm-anchor', title: text,
    }), 0];
  },
});

/** Scrivener inline annotation: a note written right in the text, never compiled. */
export const Annotation = Mark.create({
  name: 'annotation',
  parseHTML() { return [{ tag: 'span.annotation' }]; },
  renderHTML() { return ['span', { class: 'annotation' }, 0]; },
});

export const editorExtensions = (placeholder = 'Start writing…') => [
  StarterKit.configure({ code: false, codeBlock: false, link: { openOnClick: false, autolink: false } }),
  TextAlign.configure({ types: ['paragraph', 'heading'] }),
  Highlight.configure({ multicolor: true }),
  Placeholder.configure({ placeholder }),
  ScrivComment,
  Annotation,
];
