const jwt = require('jsonwebtoken');
const config = require('../config/app.config');
const ACCESS_COOKIE = 'road_as_token';
const REFRESH_COOKIE = 'road_as_refresh_token';
const REFRESH_PATH = '/api/v1/auth';
function cookieOptions(path = '/') {
  return { httpOnly: true, secure: config.cookies.secure, sameSite: config.cookies.sameSite, path };
}
function assertCookieConfig() {
  if (!['lax', 'strict', 'none'].includes(config.cookies.sameSite)) throw new Error('AUTH_COOKIE_SAME_SITE must be lax, strict or none');
  if (config.cookies.sameSite === 'none' && !config.cookies.secure) throw new Error('SameSite=None requires HTTPS and secure cookies');
}
function setSessionCookies(res, session) {
  assertCookieConfig();
  const maxAge = token => Math.max(0, jwt.decode(token).exp * 1000 - Date.now());
  res.cookie(ACCESS_COOKIE, session.token, { ...cookieOptions(), maxAge: maxAge(session.token) });
  res.cookie(REFRESH_COOKIE, session.refreshToken, { ...cookieOptions(REFRESH_PATH), maxAge: maxAge(session.refreshToken) });
  // Only expose public state; JWTs remain in HttpOnly cookies.
  return { user: session.user, requiresVerification: session.requiresVerification };
}
function clearSessionCookies(res) {
  res.clearCookie(ACCESS_COOKIE, cookieOptions());
  res.clearCookie(REFRESH_COOKIE, cookieOptions(REFRESH_PATH));
}
module.exports = { ACCESS_COOKIE, REFRESH_COOKIE, REFRESH_PATH, cookieOptions, assertCookieConfig, setSessionCookies, clearSessionCookies };
