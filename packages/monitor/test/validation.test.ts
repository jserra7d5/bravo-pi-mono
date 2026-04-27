import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCheck,
  validateSchedule,
  validateCondition,
  validateStateTransition,
} from '../src/validation.js';
import { ValidationError } from '../src/errors.js';

test('validateCheck accepts timer', () => {
  validateCheck({ type: 'timer' });
});

test('validateCheck accepts file exists', () => {
  validateCheck({ type: 'file', path: '/tmp/test', mode: 'exists' });
});

test('validateCheck rejects file contains without pattern', () => {
  assert.throws(() => validateCheck({ type: 'file', path: '/tmp/test', mode: 'contains' }), ValidationError);
});

test('validateCheck rejects unknown check type', () => {
  assert.throws(() => validateCheck({ type: 'http' } as any), ValidationError);
});

test('validateSchedule accepts empty schedule as immediate', () => {
  validateSchedule({});
});

test('validateSchedule accepts delay_ms', () => {
  validateSchedule({ delay_ms: 5000 });
});

test('validateSchedule rejects delay_ms below minimum', () => {
  assert.throws(() => validateSchedule({ delay_ms: 100 }), ValidationError);
});

test('validateSchedule rejects invalid start_at', () => {
  assert.throws(() => validateSchedule({ start_at: 'not-a-date' }), ValidationError);
});

test('validateCondition accepts always', () => {
  validateCondition({ type: 'always' });
});

test('validateCondition accepts and/or with children', () => {
  validateCondition({ type: 'and', conditions: [{ type: 'always' }] });
});

test('validateCondition rejects and without children', () => {
  assert.throws(() => validateCondition({ type: 'and', conditions: [] }), ValidationError);
});

test('validateStateTransition blocks terminal transitions', () => {
  assert.throws(() => validateStateTransition('stopped', 'running'), ValidationError);
});
