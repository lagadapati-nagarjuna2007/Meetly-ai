/**
 * Cloudflare RealtimeKit Backend Configuration & REST API Helper
 *
 * Provides reusable, secure functions for interacting with Cloudflare RealtimeKit's
 * REST API (meetings, participants, token issuance, and session termination).
 *
 * Official Cloudflare RealtimeKit REST API Documentation:
 * https://developers.cloudflare.com/realtime/realtimekit/
 *
 * Base Endpoint Pattern:
 * https://api.cloudflare.com/client/v4/accounts/{account_id}/realtime/kit/{app_id}
 */

import dotenv from 'dotenv'
import path from 'path'
import { fileURLToPath } from 'url'

// Ensure local .env is loaded if this module is imported independently
const __dirname = path.dirname(fileURLToPath(import.meta.url))
dotenv.config({ path: path.resolve(__dirname, '../../.env') })

const CLOUDFLARE_API_BASE_URL = 'https://api.cloudflare.com/client/v4'
const DEFAULT_REQUEST_TIMEOUT_MS = 15000 // 15 seconds

/**
 * Validates and retrieves required Cloudflare RealtimeKit credentials.
 * Throws a descriptive Error if any required variable is missing.
 *
 * @param {Object} [overrides] - Optional overrides for dependency injection / unit testing
 * @returns {{ accountId: string, appId: string, apiToken: string, baseUrl: string }}
 */
export const getCloudflareConfig = (overrides = {}) => {
  const accountId = (overrides.accountId || process.env.CLOUDFLARE_ACCOUNT_ID || '').trim()
  const appId = (overrides.appId || process.env.CLOUDFLARE_REALTIME_APP_ID || '').trim()
  const apiToken = (overrides.apiToken || process.env.CLOUDFLARE_API_TOKEN || '').trim()

  const missing = []
  if (!accountId) missing.push('CLOUDFLARE_ACCOUNT_ID')
  if (!appId) missing.push('CLOUDFLARE_REALTIME_APP_ID')
  if (!apiToken) missing.push('CLOUDFLARE_API_TOKEN')

  if (missing.length > 0) {
    throw new Error(
      `Cloudflare RealtimeKit configuration error: Missing required environment variable(s): ${missing.join(', ')}.`
    )
  }

  const baseUrl =
    overrides.baseUrl ||
    `${CLOUDFLARE_API_BASE_URL}/accounts/${encodeURIComponent(accountId)}/realtime/kit/${encodeURIComponent(appId)}`

  return {
    accountId,
    appId,
    apiToken,
    baseUrl
  }
}

/**
 * Safe check to verify whether all required Cloudflare credentials are set.
 * Does not throw an error.
 *
 * @returns {boolean}
 */
export const isCloudflareConfigured = () => {
  try {
    getCloudflareConfig()
    return true
  } catch {
    return false
  }
}

/**
 * Internal HTTP client for Cloudflare RealtimeKit REST API.
 * Handles timeouts, network failures, API error envelopes, and prevents credential leakage.
 *
 * @param {string} endpointPath - Relative path after the app base URL (e.g. '/meetings')
 * @param {Object} [options]
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} [options.method='GET']
 * @param {Object|null} [options.body=null] - JSON-serializable request body
 * @param {number} [options.timeoutMs=15000]
 * @param {Object} [options.configOverrides] - Optional config overrides for testing
 * @returns {Promise<any>}
 */
export const cloudflareRealtimeRequest = async (
  endpointPath,
  {
    method = 'GET',
    body = null,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    configOverrides = null
  } = {}
) => {
  const config = getCloudflareConfig(configOverrides || {})
  const cleanPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`
  const targetUrl = `${config.baseUrl}${cleanPath}`

  const headers = {
    Authorization: `Bearer ${config.apiToken}`,
    Accept: 'application/json'
  }

  const fetchOptions = {
    method,
    headers,
    signal: AbortSignal.timeout(timeoutMs)
  }

  if (body !== null && ['POST', 'PATCH', 'PUT'].includes(method.toUpperCase())) {
    headers['Content-Type'] = 'application/json'
    fetchOptions.body = JSON.stringify(body)
  }

  let response = null
  let rawText = ''

  try {
    response = await fetch(targetUrl, fetchOptions)
    rawText = await response.text()
  } catch (netErr) {
    if (netErr.name === 'TimeoutError' || netErr.name === 'AbortError') {
      const timeoutError = new Error(
        `Cloudflare RealtimeKit request timed out after ${timeoutMs}ms (${method} ${cleanPath})`
      )
      timeoutError.code = 'ETIMEDOUT'
      timeoutError.status = 504
      throw timeoutError
    }
    const connectionError = new Error(
      `Cloudflare RealtimeKit network error (${method} ${cleanPath}): ${netErr.message || 'Connection failed'}`
    )
    connectionError.code = netErr.code || 'ECONNFAILED'
    throw connectionError
  }

  let json = null
  if (rawText && rawText.trim().length > 0) {
    try {
      json = JSON.parse(rawText)
    } catch {
      const parseError = new Error(
        `Cloudflare RealtimeKit API returned unexpected non-JSON response (HTTP ${response.status})`
      )
      parseError.status = response.status
      parseError.code = 'INVALID_RESPONSE'
      throw parseError
    }
  }

  // Handle Cloudflare error envelopes and HTTP non-2xx statuses
  if (!response.ok || (json && json.success === false)) {
    let errorMessage = `HTTP ${response.status} ${response.statusText || 'Error'}`
    let errorCode = 'CLOUDFLARE_API_ERROR'
    let errorDetails = null

    if (json) {
      if (Array.isArray(json.errors) && json.errors.length > 0) {
        const firstErr = json.errors[0]
        errorMessage = firstErr.message || errorMessage
        errorCode = firstErr.code || errorCode
        errorDetails = json.errors
      } else if (json.error) {
        if (typeof json.error === 'string') {
          errorMessage = json.error
        } else if (typeof json.error === 'object') {
          errorMessage = json.error.message || json.error.errorDescription || errorMessage
          errorCode = json.error.code || json.error.errorCode || errorCode
          errorDetails = json.error
        }
      } else if (json.message) {
        errorMessage = json.message
      }
    }

    const apiError = new Error(
      `Cloudflare RealtimeKit API error (${response.status}): ${errorMessage}`
    )
    apiError.status = response.status
    apiError.code = errorCode
    if (errorDetails) {
      apiError.details = errorDetails
    }
    throw apiError
  }

  return json
}

/**
 * 1. CREATE MEETING
 * Creates a new meeting room in Cloudflare RealtimeKit.
 *
 * Endpoint: POST /accounts/{account_id}/realtime/kit/{app_id}/meetings
 *
 * @param {Object} [params]
 * @param {string} [params.title='Meetly AI Meeting'] - Human-readable meeting title
 * @param {Object} [params.extraParams={}] - Additional optional Cloudflare meeting settings
 * @param {Object} [options] - Request options
 * @returns {Promise<{ id: string, title: string, status: string, raw: Object }>}
 */
export const createCloudflareMeeting = async (
  { title = 'Meetly AI Meeting', ...extraParams } = {},
  options = {}
) => {
  if (typeof title !== 'string' || !title.trim()) {
    throw new Error('Cloudflare RealtimeKit: Meeting title must be a non-empty string.')
  }

  const payload = {
    title: title.trim(),
    ...extraParams
  }

  const result = await cloudflareRealtimeRequest('/meetings', {
    method: 'POST',
    body: payload,
    ...options
  })

  const data = result?.data || result?.result || result

  if (!data?.id) {
    throw new Error('Cloudflare RealtimeKit: Create meeting response did not include meeting ID.')
  }

  return {
    id: data.id,
    title: data.title || title,
    status: data.status || 'ACTIVE',
    createdAt: data.created_at || new Date().toISOString(),
    raw: data
  }
}

/**
 * 2. ADD PARTICIPANT & OBTAIN AUTH TOKEN
 * Enrolls a participant into a meeting and issues their client authentication token (JWT).
 *
 * Endpoint: POST /accounts/{account_id}/realtime/kit/{app_id}/meetings/{meeting_id}/participants
 *
 * @param {string} meetingId - Cloudflare meeting ID
 * @param {Object} params
 * @param {string} params.name - Participant display name
 * @param {string} params.presetName - Cloudflare RealtimeKit preset name (e.g. 'meetly-host' or 'meetly-participant')
 * @param {string} [params.customParticipantId] - Meetly internal user ID / UUID
 * @param {Object} [params.extraParams={}] - Additional optional participant properties
 * @param {Object} [options] - Request options
 * @returns {Promise<{ participantId: string, token: string, name: string, presetName: string, raw: Object }>}
 */
export const addCloudflareParticipant = async (
  meetingId,
  { name, presetName, customParticipantId = null, ...extraParams } = {},
  options = {}
) => {
  if (!meetingId || typeof meetingId !== 'string' || !meetingId.trim()) {
    throw new Error('Cloudflare RealtimeKit: Valid meetingId is required to add participant.')
  }
  if (!name || typeof name !== 'string' || !name.trim()) {
    throw new Error('Cloudflare RealtimeKit: Participant name is required.')
  }
  if (!presetName || typeof presetName !== 'string' || !presetName.trim()) {
    throw new Error('Cloudflare RealtimeKit: Preset name is required to add participant.')
  }

  const payload = {
    name: name.trim(),
    preset_name: presetName.trim(),
    ...extraParams
  }

  if (customParticipantId) {
    payload.custom_participant_id = String(customParticipantId).trim()
  }

  const endpoint = `/meetings/${encodeURIComponent(meetingId.trim())}/participants`
  const result = await cloudflareRealtimeRequest(endpoint, {
    method: 'POST',
    body: payload,
    ...options
  })

  const data = result?.data || result?.result || result

  const participantId = data?.participant_id || data?.id
  const token = data?.token || data?.authToken

  if (!participantId || !token) {
    throw new Error('Cloudflare RealtimeKit: Add participant response missing participant_id or token.')
  }

  return {
    participantId,
    token,
    name: data.name || name,
    presetName: data.preset_name || presetName,
    raw: data
  }
}

/**
 * 3. REMOVE PARTICIPANT
 * Evicts a participant from the meeting and revokes their authentication token.
 *
 * Endpoint: DELETE /accounts/{account_id}/realtime/kit/{app_id}/meetings/{meeting_id}/participants/{participant_id}
 *
 * @param {string} meetingId - Cloudflare meeting ID
 * @param {string} participantId - Cloudflare participant ID
 * @param {Object} [options] - Request options
 * @returns {Promise<{ success: boolean, meetingId: string, participantId: string }>}
 */
export const removeCloudflareParticipant = async (
  meetingId,
  participantId,
  options = {}
) => {
  if (!meetingId || typeof meetingId !== 'string' || !meetingId.trim()) {
    throw new Error('Cloudflare RealtimeKit: Valid meetingId is required to remove participant.')
  }
  if (!participantId || typeof participantId !== 'string' || !participantId.trim()) {
    throw new Error('Cloudflare RealtimeKit: Valid participantId is required to remove participant.')
  }

  const endpoint = `/meetings/${encodeURIComponent(meetingId.trim())}/participants/${encodeURIComponent(participantId.trim())}`
  const result = await cloudflareRealtimeRequest(endpoint, {
    method: 'DELETE',
    ...options
  })

  return {
    success: result?.success !== false,
    meetingId: meetingId.trim(),
    participantId: participantId.trim()
  }
}

/**
 * 4. END / DEACTIVATE MEETING
 * Sets meeting status to 'INACTIVE' to disconnect any active sessions and prevent further joins.
 *
 * Endpoint: PATCH /accounts/{account_id}/realtime/kit/{app_id}/meetings/{meeting_id}
 *
 * @param {string} meetingId - Cloudflare meeting ID
 * @param {Object} [options] - Request options
 * @returns {Promise<{ success: boolean, id: string, status: string, raw: Object }>}
 */
export const endCloudflareMeeting = async (meetingId, options = {}) => {
  if (!meetingId || typeof meetingId !== 'string' || !meetingId.trim()) {
    throw new Error('Cloudflare RealtimeKit: Valid meetingId is required to end meeting.')
  }

  const endpoint = `/meetings/${encodeURIComponent(meetingId.trim())}`
  const result = await cloudflareRealtimeRequest(endpoint, {
    method: 'PATCH',
    body: { status: 'INACTIVE' },
    ...options
  })

  const data = result?.data || result?.result || result

  return {
    success: result?.success !== false,
    id: meetingId.trim(),
    status: data?.status || 'INACTIVE',
    raw: data
  }
}

/**
 * 5. REFRESH PARTICIPANT TOKEN
 * Rotates or refreshes an authentication token for an enrolled participant.
 *
 * Endpoint: POST /accounts/{account_id}/realtime/kit/{app_id}/meetings/{meeting_id}/participants/{participant_id}/token
 *
 * @param {string} meetingId - Cloudflare meeting ID
 * @param {string} participantId - Cloudflare participant ID
 * @param {Object} [params]
 * @param {string} [params.notBefore] - Optional RFC 3339 timestamp
 * @param {string} [params.expiresOn] - Optional RFC 3339 timestamp
 * @param {Object} [options] - Request options
 * @returns {Promise<{ token: string, raw: Object }>}
 */
export const refreshCloudflareParticipantToken = async (
  meetingId,
  participantId,
  { notBefore = null, expiresOn = null } = {},
  options = {}
) => {
  if (!meetingId || typeof meetingId !== 'string' || !meetingId.trim()) {
    throw new Error('Cloudflare RealtimeKit: Valid meetingId is required to refresh token.')
  }
  if (!participantId || typeof participantId !== 'string' || !participantId.trim()) {
    throw new Error('Cloudflare RealtimeKit: Valid participantId is required to refresh token.')
  }

  const payload = {}
  if (notBefore) payload.not_before = notBefore
  if (expiresOn) payload.expires_on = expiresOn

  const endpoint = `/meetings/${encodeURIComponent(meetingId.trim())}/participants/${encodeURIComponent(participantId.trim())}/token`
  const result = await cloudflareRealtimeRequest(endpoint, {
    method: 'POST',
    body: Object.keys(payload).length > 0 ? payload : null,
    ...options
  })

  const data = result?.data || result?.result || result
  const token = data?.token || data?.authToken

  if (!token) {
    throw new Error('Cloudflare RealtimeKit: Refresh token response did not include token.')
  }

  return {
    token,
    raw: data
  }
}
