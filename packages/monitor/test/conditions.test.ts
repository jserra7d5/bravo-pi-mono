import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCondition } from '../src/conditions/evaluator.js';

test('always matches', () => {
  assert.equal(evaluateCondition({ type: 'always' }, { status: 'matched', triggered: true, condition_matched: true, result_id: 'r1', monitor_id: 'm1', created_at: '' }), true);
});

test('observation_status equals', () => {
  assert.equal(evaluateCondition({ type: 'observation_status', equals: 'matched' }, { status: 'matched', triggered: true, condition_matched: true, result_id: 'r1', monitor_id: 'm1', created_at: '' }), true);
  assert.equal(evaluateCondition({ type: 'observation_status', equals: 'error' }, { status: 'matched', triggered: true, condition_matched: true, result_id: 'r1', monitor_id: 'm1', created_at: '' }), false);
});

test('text_contains case sensitive', () => {
  const result: any = { status: 'matched', triggered: true, condition_matched: true, result_id: 'r1', monitor_id: 'm1', created_at: '', observation: { message: 'Hello World' } };
  assert.equal(evaluateCondition({ type: 'text_contains', path: 'message', text: 'World' }, result), true);
  assert.equal(evaluateCondition({ type: 'text_contains', path: 'message', text: 'world' }, result), false);
});

test('text_contains case insensitive', () => {
  const result: any = { status: 'matched', triggered: true, condition_matched: true, result_id: 'r1', monitor_id: 'm1', created_at: '', observation: { message: 'Hello World' } };
  assert.equal(evaluateCondition({ type: 'text_contains', path: 'message', text: 'world', case_sensitive: false }, result), true);
});

test('and requires all true', () => {
  const result: any = { status: 'matched', triggered: true, condition_matched: true, result_id: 'r1', monitor_id: 'm1', created_at: '', observation: { a: 'yes', b: 'yes' } };
  assert.equal(evaluateCondition({ type: 'and', conditions: [
    { type: 'text_contains', path: 'a', text: 'yes' },
    { type: 'text_contains', path: 'b', text: 'yes' },
  ] }, result), true);
  assert.equal(evaluateCondition({ type: 'and', conditions: [
    { type: 'text_contains', path: 'a', text: 'yes' },
    { type: 'text_contains', path: 'b', text: 'no' },
  ] }, result), false);
});

test('or requires any true', () => {
  const result: any = { status: 'matched', triggered: true, condition_matched: true, result_id: 'r1', monitor_id: 'm1', created_at: '', observation: { a: 'yes' } };
  assert.equal(evaluateCondition({ type: 'or', conditions: [
    { type: 'text_contains', path: 'a', text: 'no' },
    { type: 'text_contains', path: 'a', text: 'yes' },
  ] }, result), true);
});

test('not inverts', () => {
  const result: any = { status: 'matched', triggered: true, condition_matched: true, result_id: 'r1', monitor_id: 'm1', created_at: '' };
  assert.equal(evaluateCondition({ type: 'not', condition: { type: 'always' } }, result), false);
});

test('default condition matches on matched status', () => {
  const result: any = { status: 'matched', triggered: true, condition_matched: true, result_id: 'r1', monitor_id: 'm1', created_at: '' };
  assert.equal(evaluateCondition(undefined, result), true);
  const notMatched: any = { status: 'not_matched', triggered: false, condition_matched: false, result_id: 'r2', monitor_id: 'm1', created_at: '' };
  assert.equal(evaluateCondition(undefined, notMatched), false);
});
