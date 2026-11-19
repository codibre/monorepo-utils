import type { FileFormat } from './types';

/**
 * Built-in seed content for `config-loom add`, keyed by file name. Content
 * may contain the `{{root}}` placeholder, which render expands per
 * workspace into the relative path up to the repo root (one `../` per path
 * segment: `libs/a` renders `../../`), so a uniform shim stays correct at
 * any workspace depth.
 *
 * Known templates are CONVENTIONS, not law: `--template` overrides the
 * content at add time, and the entry is a plain loom entry afterwards —
 * edit it (rules, scopes) like any other.
 */
export interface KnownTemplate {
  format: FileFormat;
  content: string;
}

export const KNOWN_TEMPLATES: Record<string, KnownTemplate> = {
  '.release-it.js': {
    format: 'ts',
    content: "module.exports = require('{{root}}/.release-it.base.js');\n",
  },
  '.release-it.json': {
    format: 'json',
    content: '{\n  "extends": "{{root}}/.release-it.base.js"\n}\n',
  },
};
