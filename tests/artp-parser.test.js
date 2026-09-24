import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArtp } from '../artp/parser.js';

const valid = 'ARTP/1\nP: "@APP"\nDO: "Fix scroll"\nNO: ["op:create_file"]\n';
test('ARTP/1 parses JSON values without interpreting field order or escaped content', () => {
  const result = parseArtp(valid);
  assert.equal(result.fields.DO, 'Fix scroll'); assert.deepEqual(result.fields.NO, ['op:create_file']);
  assert.equal(result.descriptor_hash, parseArtp(valid).descriptor_hash);
  assert.equal(parseArtp('ARTP/1\nDO: "line\\nnext — ñ"\nP: "@APP"').fields.DO, 'line\nnext — ñ');
});

test('ARTP/1 rejects unsupported or ambiguous input with field locations', () => {
  const cases = [
    ['ARTP/2\nP: "x"\nDO: "x"', 'ARTP_UNSUPPORTED_VERSION'],
    ['bad\nP: "x"\nDO: "x"', 'ARTP_PARSE_ERROR'],
    ['ARTP/1\nDO: "x"', 'ARTP_MISSING_REQUIRED_FIELD'],
    ['ARTP/1\nP: "x"', 'ARTP_MISSING_REQUIRED_FIELD'],
    ['ARTP/1\nP: "x"\nDO: "x"\nBUG: "bad"', 'ARTP_UNKNOWN_FIELD'],
    ['ARTP/1\nP: "x"\nP: "y"\nDO: "x"', 'ARTP_DUPLICATE_FIELD'],
    ['ARTP/1\nP: "x"\nDO: bad', 'ARTP_PARSE_ERROR'],
    ['ARTP/1\nP: ["x"]\nDO: "x"', 'ARTP_INVALID_FIELD_TYPE'],
    ['ARTP/1\nP: "x"\nDO: "x"\nF: "bad"', 'ARTP_INVALID_FIELD_TYPE'],
    ['ARTP/1\nP: "x"\nDO: ""', 'ARTP_INVALID_FIELD_TYPE'],
    ['ARTP/1\nP: "x"\nDO: "x"\nF: ["a","b","c"]', 'ARTP_LIST_TOO_LARGE'],
    [`ARTP/1\nP: "x"\nDO: "${'a'.repeat(17000)}"`, 'ARTP_DESCRIPTOR_TOO_LARGE'],
    ['ARTP/1\nP: "x"\nDO: "bad\nline"', 'ARTP_PARSE_ERROR'],
    ['ARTP/1\nP: "x"\nDO: "\uFFFD"', 'ARTP_PARSE_ERROR']
  ];
  for (const [value, code] of cases) {
    const limits = code === 'ARTP_LIST_TOO_LARGE' ? { descriptorBytes: 16384, listItems: 2, valueChars: 8192 } : undefined;
    assert.throws(() => parseArtp(value, limits), (error) => error.code === code && Number.isInteger(error.details?.line));
  }
});
