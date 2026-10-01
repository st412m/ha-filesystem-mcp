'use strict';
// The SQL statement check, without sqlite3. Expected outcome is the part of the
// id after the first dash: OK passes, anything else is the refusal code.
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateSql } = require('../filesystem_mcp/sqlite.js');

const CASES = [
  ['P01-OK', "SELECT 'a;b' AS s"],
  ['P02-OK', "SELECT 'it''s; fine' AS s"],
  ['P03-OK', "SELECT 1 AS \"a;b\""],
  ['P04-OK', "SELECT 1 AS `a;b`"],
  ['P05-OK', "SELECT 1 AS [a;b]"],
  ['P06-OK', "SELECT 1 AS x -- trailing; comment"],
  ['P07-OK', "SELECT 1 AS x /* ; */"],
  ['P08-OK', "SELECT 1 AS x;"],
  ['P09-OK', "SELECT '\\' AS s"],
  ['P10-OK', "SELECT hex(x'00FF') AS h, '--' AS a, '/*' AS b, '$a' AS c"],
  ['P11-OK', "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<50) SELECT x FROM c -- tail"],
  ['P12-OK', "EXPLAIN QUERY PLAN SELECT ';' AS s"],
  ['R01-MULTIPLE_STATEMENTS', "SELECT 1; SELECT 2"],
  ['R02-MULTIPLE_STATEMENTS', "SELECT 'a'; SELECT 'b'"],
  ['R03-MULTIPLE_STATEMENTS', "SELECT '\\'; SELECT 2 --'"],
  ['R04-MULTIPLE_STATEMENTS', "SELECT 1;;"],
  ['R05-MULTIPLE_STATEMENTS', "SELECT 1; -- note"],
  ['R06-MULTIPLE_STATEMENTS', "EXPLAIN SELECT 1; SELECT 2"],
  ['R07-MALFORMED_SQL', "SELECT 1 AS x) ; SELECT 2 AS y /*"],
  ['R08-MALFORMED_SQL', "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM c WHERE x<50) SELECT x FROM c) --"],
  ['R09-MALFORMED_SQL', "SELECT 'abc"],
  ['R10-MALFORMED_SQL', "SELECT 1 AS \"a\"\"b"],
  ['R11-MALFORMED_SQL', "SELECT [a"],
  ['R12-MALFORMED_SQL', "SELECT 1 /* open"],
  ['R13-MALFORMED_SQL', "SELECT 1 /*/ ; SELECT 2"],
  ['R14-MALFORMED_SQL', "SELECT ((1)"],
  ['R15-PARAMETERS_NOT_SUPPORTED', "SELECT 1 AS x WHERE $a(') ) ; SELECT 2 AS y /*')"],
  ['R16-PARAMETERS_NOT_SUPPORTED', "SELECT ?"],
  ['R17-PARAMETERS_NOT_SUPPORTED', "SELECT :a, @b, #c"],
  ['R18-DOT_COMMAND', ".tables"],
  ['R19-INVALID_STATEMENT', "DELETE FROM t"],
];

test('31 statement cases', () => {
  assert.equal(CASES.length, 31);
});

for (const [id, sql] of CASES) {
  const expected = id.slice(id.indexOf('-') + 1);
  test(`${id}: ${sql}`, () => {
    if (expected === 'OK') {
      assert.doesNotThrow(() => validateSql(sql));
    } else {
      assert.throws(() => validateSql(sql), e => e.message.startsWith(`${expected}:`));
    }
  });
}
