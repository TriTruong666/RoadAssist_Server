const { test } = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const config = require('../src/config/app.config');
const Cookies = require('../src/utils/auth_cookie.util');
test('production cookies are HttpOnly/Secure with matching scope when set and cleared', () => {
  const previous = { ...config.cookies };
  config.cookies.secure = true;
  config.cookies.sameSite = 'none';
  try {
    const written = [], cleared = [];
    const response = { cookie: (...args) => written.push(args), clearCookie: (...args) => cleared.push(args) };
    const signingSecret = 'cookie-unit-test-secret-never-used-by-the-server';
    const token = jwt.sign({ use: 'access' }, signingSecret, { expiresIn: '7d' });
    const refreshToken = jwt.sign({ use: 'refresh' }, signingSecret, { expiresIn: '30d' });
    const result = Cookies.setSessionCookies(response, { token, refreshToken, user: { name: 'Test' }, requiresVerification: false });
    assert.equal(result.token, undefined);
    assert.equal(result.refreshToken, undefined);
    assert.deepEqual(result.user, { name: 'Test' });
    assert.equal(written[0][0], 'road_as_token');
    assert.equal(written[1][0], 'road_as_refresh_token');
    assert.equal(written[0][2].path, '/');
    assert.equal(written[1][2].path, '/api/v1/auth');
    for (const [name, value, options] of written) {
      assert.equal(options.httpOnly, true);
      assert.equal(options.secure, true);
      assert.equal(options.sameSite, 'none');
      assert.ok(Math.abs(options.maxAge - (jwt.decode(value).exp * 1000 - Date.now())) < 1000);
    }
    Cookies.clearSessionCookies(response);
    assert.equal(cleared.length, 2);
    for (let i = 0; i < 2; i++) {
      const { maxAge, ...options } = written[i][2];
      assert.equal(cleared[i][0], written[i][0]);
      assert.deepEqual(cleared[i][1], options);
    }
  } finally { Object.assign(config.cookies, previous); }
});
test('invalid cookie policy and SameSite=None without HTTPS are rejected', () => {
  const previous = { ...config.cookies };
  try {
    config.cookies.sameSite = 'invalid';
    assert.throws(Cookies.assertCookieConfig, /AUTH_COOKIE_SAME_SITE/);
    config.cookies.sameSite = 'none';
    config.cookies.secure = false;
    assert.throws(Cookies.assertCookieConfig, /HTTPS/);
  } finally { Object.assign(config.cookies, previous); }
});
