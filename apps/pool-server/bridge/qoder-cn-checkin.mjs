import { BridgeError } from './runtime.mjs';

const API_BASE = 'https://openapi.qoder.com.cn';
const REQUEST_TIMEOUT_MS = 15_000;

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function unwrap(value) {
  const body = asObject(value);
  return asObject(body.data);
}

function number(value) {
  return Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : null;
}

function campaignCredit(campaign) {
  const benefit = asObject(campaign?.benefit);
  return String(benefit.kind ?? '').toUpperCase() === 'CREDITS' ? number(benefit.amount) : null;
}

function campaignRows(payload) {
  const direct = asObject(payload).campaigns;
  const nested = unwrap(payload).campaigns;
  return Array.isArray(direct) ? direct : Array.isArray(nested) ? nested : [];
}

function claimableCampaign(rows) {
  const now = Math.floor(Date.now() / 1_000);
  return rows.find(candidate => {
    const row = asObject(candidate);
    if (String(row.actionType ?? '').toUpperCase() !== 'CLAIM_BENEFIT') return false;
    if (String(row.claimStatus ?? '').toUpperCase() !== 'CLAIMABLE') return false;
    const startAt = number(row.startAt);
    const endAt = number(row.endAt);
    return (startAt === null || startAt <= 0 || now >= startAt) && (endAt === null || endAt <= 0 || now <= endAt);
  });
}

function claimedCampaign(rows) {
  return rows.find(candidate => {
    const row = asObject(candidate);
    return String(row.actionType ?? '').toUpperCase() === 'CLAIM_BENEFIT'
      && String(row.claimStatus ?? '').toUpperCase() === 'CLAIMED';
  });
}

function isAlreadyClaimed(payload) {
  const body = asObject(payload);
  const data = unwrap(payload);
  return [body.result, body.code, body.status, data.result, data.code, data.status]
    .some(value => String(value ?? '').toUpperCase() === 'ALREADY_CLAIMED');
}

function isClaimSuccess(payload) {
  const body = asObject(payload);
  const data = unwrap(payload);
  return body.success === true || data.success === true || [body.result, body.status, data.result, data.status]
    .some(value => String(value ?? '').toUpperCase() === 'CLAIMED');
}

function qoderHeaders(accessToken) {
  return {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'User-Agent': 'Qoder',
    'Cosy-ClientType': '10',
    'Cosy-Version': '0.3.4',
  };
}

async function parseJson(response) {
  try { return await response.json(); }
  catch { return {}; }
}

async function request(url, init, operation) {
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch (error) {
    if (error?.name === 'TimeoutError') throw new BridgeError('CHECKIN_TIMEOUT', 'Qoder CN 活动服务响应超时', true);
    throw new BridgeError('CHECKIN_UNAVAILABLE', 'Qoder CN 活动服务暂时不可用', true);
  }
  const payload = await parseJson(response);
  if (response.status === 401 || response.status === 403) {
    throw new BridgeError('CHECKIN_AUTH_REQUIRED', 'Qoder CN 签到 PAT 无效或已过期');
  }
  if (response.status === 429) throw new BridgeError('CHECKIN_RATE_LIMITED', 'Qoder CN 活动请求过于频繁，请稍后再试', true);
  if (response.status >= 500) throw new BridgeError('CHECKIN_UNAVAILABLE', 'Qoder CN 活动服务暂时不可用', true);
  if (response.status >= 400 && !(operation === 'claim' && response.status === 409)) {
    throw new BridgeError('CHECKIN_FAILED', 'Qoder CN 未确认活动领取状态');
  }
  return { status: response.status, payload };
}

/**
 * Claims a Qoder CN campaign benefit through a user supplied CN PAT.
 * Browser-login credentials remain inside qoderclicn; this function never
 * reads them and never returns a token or raw upstream response.
 */
export async function qoderCnCheckin(personalToken) {
  if (typeof personalToken !== 'string' || !personalToken.trim()) {
    return { status: 'INACTIVE', message: '未设置 Qoder CN 签到 PAT，无法领取活动权益' };
  }
  const exchange = await request(`${API_BASE}/api/v1/jobToken/exchange`, {
    method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ personal_token: personalToken.trim() }),
  }, 'exchange');
  const accessToken = String(asObject(exchange.payload).token ?? unwrap(exchange.payload).token ?? '');
  if (!accessToken) throw new BridgeError('CHECKIN_AUTH_REQUIRED', 'Qoder CN 签到 PAT 无效或已过期');

  const status = await request(`${API_BASE}/sash/api/v1/me/campaigns?forceRefresh=true`, {
    method: 'GET', headers: qoderHeaders(accessToken),
  }, 'status');
  const campaigns = campaignRows(status.payload);
  const candidate = claimableCampaign(campaigns);
  if (!candidate) {
    const claimed = claimedCampaign(campaigns);
    return claimed
      ? { status: 'ALREADY', message: '今日活动权益已领取', credits: campaignCredit(claimed) }
      : { status: 'INACTIVE', message: '今日暂无可领取的 Qoder CN 活动权益' };
  }

  const campaignId = String(asObject(candidate).campaignId ?? '');
  if (!campaignId) throw new BridgeError('CHECKIN_FAILED', 'Qoder CN 活动信息不完整');
  const claim = await request(`${API_BASE}/sash/api/v1/me/campaigns/${encodeURIComponent(campaignId)}/claim`, {
    method: 'POST', headers: qoderHeaders(accessToken), body: '{}',
  }, 'claim');
  const response = asObject(claim.payload);
  const data = unwrap(response);
  const credits = number(data.rewardCredits ?? response.rewardCredits) ?? campaignCredit(candidate);
  if (claim.status === 409 || isAlreadyClaimed(response)) {
    return { status: 'ALREADY', message: '今日活动权益已领取', credits };
  }
  if (isClaimSuccess(response)) return { status: 'SUCCESS', message: 'Qoder CN 活动权益领取成功', credits };
  return { status: 'FAILED', message: 'Qoder CN 未确认活动权益领取成功' };
}
