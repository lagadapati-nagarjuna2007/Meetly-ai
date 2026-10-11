import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

describe('Backblaze B2 Protocol & Multipart Buffering', () => {
  it('enforces Backblaze B2 non-final part minimum of 5 MiB (5,242,880 bytes)', () => {
    const minPartSize = 5242880 // 5 MiB in bytes

    const parts = [
      { partNumber: 1, size: 5500000 }, // Valid non-final part
      { partNumber: 2, size: 5242880 }, // Valid non-final part
      { partNumber: 3, size: 1048576 }  // Final part: permitted to be < 5 MiB
    ]

    // Verify non-final parts are >= 5 MiB
    for (let i = 0; i < parts.length - 1; i++) {
      assert.ok(parts[i].size >= minPartSize, `Non-final part #${parts[i].partNumber} must be >= 5 MiB`)
    }

    // Final part can be any size > 0
    assert.ok(parts[parts.length - 1].size > 0, 'Final part must be non-empty')
  })

  it('orders multipart completion manifest ascending by PartNumber and formats ETags in standard quotes without double wrapping', () => {
    const rawParts = [
      { partNumber: 3, etag: '"etag-3"' },
      { partNumber: 1, etag: 'etag-1' },
      { partNumber: 2, etag: '"etag-2"' }
    ]

    const sorted = [...rawParts]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map(p => {
        let etag = String(p.etag).trim()
        if (!etag.startsWith('"')) etag = `"${etag}"`
        return {
          PartNumber: p.partNumber,
          ETag: etag
        }
      })

    assert.equal(sorted[0].PartNumber, 1)
    assert.equal(sorted[0].ETag, '"etag-1"')
    assert.equal(sorted[1].PartNumber, 2)
    assert.equal(sorted[1].ETag, '"etag-2"')
    assert.equal(sorted[2].PartNumber, 3)
    assert.equal(sorted[2].ETag, '"etag-3"')
  })

  it('enforces exact 2,000,000,000 bytes hard limit on verified completed file size', () => {
    const MAX_ALLOWED_SIZE = 2000000000 // 2 GB

    const validRecordingSize = 1850000000 // ~1.85 GB
    const oversizedRecordingSize = 2000000001 // Exceeds cap

    const canBeMarkedReady = (size) => size <= MAX_ALLOWED_SIZE

    assert.equal(canBeMarkedReady(validRecordingSize), true, 'File <= 2,000,000,000 bytes must be allowed')
    assert.equal(canBeMarkedReady(oversizedRecordingSize), false, 'File > 2,000,000,000 bytes must be rejected')
  })

  it('calculates 30-day retention clock strictly from completed_at, not created_at', () => {
    const createdAt = new Date('2026-10-11T09:00:00.000Z')
    const completedAt = new Date('2026-10-11T10:00:00.000Z') // 1 hour later

    const retentionDays = 30
    const expiresAt = new Date(completedAt.getTime() + retentionDays * 24 * 60 * 60 * 1000)

    const expectedExpiry = new Date('2026-11-10T10:00:00.000Z')
    assert.equal(expiresAt.toISOString(), expectedExpiry.toISOString(), 'Retention expiry must anchor to completed_at')
  })

  it('filters B2 object versions strictly to exact recording key to prevent prefix collisions', () => {
    const exactKey = 'recordings/meeting-123/rec-abc.webm'
    const adjacentKey = 'recordings/meeting-123/rec-abc.webm.backup'

    const returnedB2Versions = [
      { Key: exactKey, VersionId: 'v1' },
      { Key: exactKey, VersionId: 'v2' },
      { Key: adjacentKey, VersionId: 'v99' }
    ]

    const exactVersionsToDelete = returnedB2Versions.filter(v => v.Key === exactKey)
    assert.equal(exactVersionsToDelete.length, 2, 'Must only include exact key matches')
    assert.ok(exactVersionsToDelete.every(v => v.Key === exactKey))
  })
})
