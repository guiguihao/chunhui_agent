import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isValidCron, cronValidationError } from '../../src/services/cron-utils.js';

describe('isValidCron — 5 字段表达式', () => {
  test('接受常见的 5 段写法', () => {
    for (const expr of [
      '0 9 * * *',
      '*/10 * * * *',
      '0 8-22/2 * * 1-5',
      '0,30 7,19 * * 0',
      '5/15 * * * *',
      '0 0 1 1 7',
    ]) {
      assert.equal(isValidCron(expr), true, expr);
    }
  });

  test('拒绝 6 段（带秒）表达式', () => {
    // node-cron v4 支持 6 段，但前端表单只认 5 段，
    // 放行会导致「AI 能建、WebUI 保存报错」且任务按秒执行
    assert.equal(isValidCron('0 0 9 * * *'), false);
    assert.equal(isValidCron('*/5 * * * * *'), false);
  });

  test('拒绝取值越界与非法字符', () => {
    for (const expr of [
      '',
      '* * * *',
      '60 * * * *',
      '* 24 * * *',
      '* * 0 * *',
      '* * * 13 *',
      '* * * * 8',
      'a b c d e',
      '0 9 * * ,',
      '*/0 * * * *',
    ]) {
      assert.equal(isValidCron(expr), false, expr);
    }
  });

  test('空值/非字符串不抛错', () => {
    assert.equal(isValidCron(undefined), false);
    assert.equal(isValidCron(null), false);
  });
});

describe('cronValidationError — 面向模型/用户的错误说明', () => {
  test('段数不符时提示不支持秒级 6 段', () => {
    const msg = cronValidationError('0 0 9 * * *');
    assert.match(msg, /5 段/);
    assert.match(msg, /6 段/);
  });

  test('空值与越界给出可读说明', () => {
    assert.match(cronValidationError(''), /不能为空/);
    assert.match(cronValidationError('99 9 * * *'), /0-59/);
  });
});
