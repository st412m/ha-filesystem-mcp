'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { TOOLS } = require('../filesystem_mcp/server.js');

// name: [title, readOnly, destructive, idempotent, openWorld]
const EXPECTED = {
  grep_files: ['Search file contents', true, false, true, false],
  read_text_file: ['Read text file', true, false, true, false],
  read_file: ['Read file (deprecated)', true, false, true, false],
  read_media_file: ['Read media file', true, false, true, false],
  read_pdf_page: ['Render PDF page', true, false, true, false],
  read_pdf_text: ['Extract PDF text', true, false, true, false],
  sqlite_schema: ['Inspect SQLite schema', true, false, true, false],
  sqlite_query: ['Query SQLite database', true, false, true, false],
  read_multiple_files: ['Read multiple files', true, false, true, false],
  write_file: ['Write file', false, true, false, false],
  edit_file: ['Edit file', false, true, false, false],
  create_directory: ['Create directory', false, false, true, false],
  list_directory: ['List directory', true, false, true, false],
  list_directory_with_sizes: ['List directory with sizes', true, false, true, false],
  directory_tree: ['Show directory tree', true, false, true, false],
  move_file: ['Move or rename', false, true, false, false],
  trash_file: ['Move to trash', false, true, false, false],
  search_files: ['Find files by name', true, false, true, false],
  get_file_info: ['Get file info', true, false, true, false],
  list_allowed_directories: ['List allowed directories', true, false, true, false],
};

test('20 tools, the same names as the table', () => {
  assert.equal(TOOLS.length, 20);
  assert.deepEqual(TOOLS.map(t => t.name).sort(), Object.keys(EXPECTED).sort());
});

test('every tool has title, annotations.title and four boolean hints matching the table', () => {
  for (const t of TOOLS) {
    const [title, readOnly, destructive, idempotent, openWorld] = EXPECTED[t.name];
    assert.equal(t.title, title, t.name);
    assert.equal(t.annotations.title, t.title, t.name);
    assert.deepEqual(
      [t.annotations.readOnlyHint, t.annotations.destructiveHint, t.annotations.idempotentHint, t.annotations.openWorldHint],
      [readOnly, destructive, idempotent, openWorld], t.name);
    assert.equal(Object.keys(t.annotations).length, 5, t.name);
    assert.equal(typeof t.description, 'string', t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
  }
});
