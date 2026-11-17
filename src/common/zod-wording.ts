import { z } from 'zod';

/**
 * The wording of zod's built-in validation messages (ADR-037 §3).
 *
 * zod 4 rewrote its default English messages ("Too small: expected string to have >=1 characters" where zod 3 said
 * "String must contain at least 1 character(s)"), and these reach people: the `issues` of an HTTP 422, the text of an
 * MCP tool error, the line a CLI prints for a bad flag. Moving to zod 4 must not change what they read, so this one
 * place gives the built-in messages the wording zod 3 used. A schema that names its own message keeps it: zod asks the
 * schema first, this map second, its own English last.
 *
 * Imported for its effect by every module that decodes input for a person (`diplomat/mcp`, `diplomat/http`,
 * `diplomat/cli`, `config`); it is idempotent, so being imported by several is harmless.
 */
type Issue = Parameters<NonNullable<z.core.$ZodConfig['customError']>>[0];
type IssueOf<Code extends string> = Extract<Issue, { code: Code }>;
type Wording = { [Code in NonNullable<Issue['code']>]?: (issue: IssueOf<Code>) => string | undefined };

const UNKNOWN_TYPE = 'unknown';
const REQUIRED = 'Required';
const INVALID_INPUT = 'Invalid input';

const receivedType = (input: unknown): string => {
  if (input === null) return 'null';
  if (Array.isArray(input)) return 'array';
  if (typeof input === 'number' && Number.isNaN(input)) return 'nan';
  return typeof input === 'undefined' ? 'undefined' : typeof input;
};

const expectedType = (expected: string): string => (expected === 'int' ? 'integer' : expected);

const quoted = (value: unknown): string => (typeof value === 'string' ? `'${value}'` : JSON.stringify(value));

const joined = (values: readonly unknown[], separator: string): string => values.map(quoted).join(separator);

const invalidType = ({ expected, input }: IssueOf<'invalid_type'>): string =>
  input === undefined
    ? REQUIRED
    : `Expected ${expectedType(expected)}, received ${expected === 'int' ? 'float' : receivedType(input)}`;

const invalidValue = ({ values, input }: IssueOf<'invalid_value'>): string => {
  if (values.length === 1) return `Invalid literal value, expected ${JSON.stringify(values[0])}`;
  if (input === undefined) return REQUIRED;
  const expected = joined(values, ' | ');
  return typeof input === 'string'
    ? `Invalid enum value. Expected ${expected}, received ${quoted(input)}`
    : `Expected ${expected}, received ${receivedType(input)}`;
};

const COUNTED_UNIT: Readonly<Record<string, string>> = {
  string: 'character(s)',
  array: 'element(s)',
  set: 'element(s)',
};
const BOUND_SUBJECT: Readonly<Record<string, string>> = { string: 'String', array: 'Array', set: 'Set' };

const tooSmall = ({ origin, minimum, inclusive, exact }: IssueOf<'too_small'>): string => {
  const unit = COUNTED_UNIT[origin];
  if (unit === undefined) return `Number must be ${inclusive ? 'greater than or equal to' : 'greater than'} ${minimum}`;
  const bound = exact ? 'exactly' : inclusive ? 'at least' : 'over';
  return `${BOUND_SUBJECT[origin] ?? UNKNOWN_TYPE} must contain ${bound} ${minimum} ${unit}`;
};

const tooBig = ({ origin, maximum, inclusive, exact }: IssueOf<'too_big'>): string => {
  const unit = COUNTED_UNIT[origin];
  if (unit === undefined) return `Number must be ${inclusive ? 'less than or equal to' : 'less than'} ${maximum}`;
  const bound = exact ? 'exactly' : inclusive ? 'at most' : 'under';
  return `${BOUND_SUBJECT[origin] ?? UNKNOWN_TYPE} must contain ${bound} ${maximum} ${unit}`;
};

const NAMED_FORMATS: ReadonlySet<string> = new Set(['url', 'email', 'uuid', 'cuid', 'datetime', 'ipv4', 'ipv6']);

const invalidFormat = ({ format }: IssueOf<'invalid_format'>): string =>
  NAMED_FORMATS.has(format) ? `Invalid ${format}` : 'Invalid';

const WORDING: Wording = {
  invalid_type: invalidType,
  invalid_value: invalidValue,
  too_small: tooSmall,
  too_big: tooBig,
  invalid_format: invalidFormat,
  not_multiple_of: ({ divisor }) => `Number must be a multiple of ${divisor}`,
  unrecognized_keys: ({ keys }) => `Unrecognized key(s) in object: ${joined(keys, ', ')}`,
  invalid_union: () => INVALID_INPUT,
  custom: () => INVALID_INPUT,
};

const wordingOf = (issue: Issue): string | undefined =>
  issue.code === undefined
    ? undefined
    : (WORDING[issue.code] as ((i: Issue) => string | undefined) | undefined)?.(issue);

z.config({ customError: wordingOf });
