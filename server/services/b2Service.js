import {
  S3Client,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListPartsCommand,
  HeadObjectCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  ListObjectVersionsCommand,
  DeleteObjectsCommand
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'

// Resolve environment variables supporting both B2_* and AWS_* naming conventions configured in Render
const getB2Config = () => {
  const keyId = process.env.B2_APPLICATION_KEY_ID || process.env.B2_KEY_ID || process.env.AWS_ACCESS_KEY_ID
  const appKey = process.env.B2_APPLICATION_KEY || process.env.B2_APP_KEY || process.env.AWS_SECRET_ACCESS_KEY
  const bucketName = process.env.B2_BUCKET_NAME || process.env.B2_BUCKET

  // Endpoint can be explicit or constructed from region
  let endpoint = process.env.B2_ENDPOINT
  let region = process.env.B2_REGION || process.env.AWS_REGION || 'us-west-004'

  if (!endpoint && region) {
    endpoint = `https://s3.${region}.backblazeb2.com`
  }

  // If endpoint is present, infer region from hostname if region is default
  if (endpoint && endpoint.includes('.backblazeb2.com')) {
    const match = endpoint.match(/s3\.([a-z0-9-]+)\.backblazeb2/)
    if (match && match[1]) {
      region = match[1]
    }
  }

  return {
    keyId,
    appKey,
    bucketName,
    endpoint,
    region,
    forcePathStyle: process.env.B2_FORCE_PATH_STYLE === 'true' || (Boolean(endpoint) && endpoint.includes('.backblazeb2.com') && process.env.B2_FORCE_PATH_STYLE !== 'false')
  }
}

let s3ClientInstance = null

export const getS3Client = () => {
  if (s3ClientInstance) return s3ClientInstance

  const config = getB2Config()
  if (!config.keyId || !config.appKey) {
    console.warn('[B2 Service Warning] B2 credentials not detected in environment. Operating in mock or degraded mode.')
  }

  s3ClientInstance = new S3Client({
    region: config.region,
    endpoint: config.endpoint,
    credentials: config.keyId && config.appKey ? {
      accessKeyId: config.keyId,
      secretAccessKey: config.appKey
    } : undefined,
    forcePathStyle: config.forcePathStyle
  })

  return s3ClientInstance
}

export const getBucketName = () => {
  const config = getB2Config()
  return config.bucketName || 'meetly-recordings-bucket'
}

/**
 * Initializes a new multipart upload session in Backblaze B2.
 */
export const createMultipartUpload = async (key, mimeType = 'video/webm') => {
  const client = getS3Client()
  const bucket = getBucketName()

  const command = new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    ContentType: mimeType
  })

  const response = await client.send(command)
  return {
    uploadId: response.UploadId,
    key: response.Key || key
  }
}

/**
 * Generates a short-lived presigned URL (15 mins) for direct browser-to-B2 part upload.
 */
export const getPresignedPartUrl = async (key, uploadId, partNumber, expiresInSeconds = 900) => {
  const client = getS3Client()
  const bucket = getBucketName()

  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: Number(partNumber)
  })

  const presignedUrl = await getSignedUrl(client, command, { expiresIn: expiresInSeconds })
  return {
    partNumber: Number(partNumber),
    presignedUrl,
    expiresInSeconds
  }
}

/**
 * Uploads a single part directly from the server to Backblaze B2 (CORS-free fallback).
 */
export const uploadPart = async (key, uploadId, partNumber, body) => {
  const client = getS3Client()
  const bucket = getBucketName()

  const command = new UploadPartCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    PartNumber: Number(partNumber),
    Body: body
  })

  const response = await client.send(command)
  return {
    partNumber: Number(partNumber),
    etag: response.ETag
  }
}

/**
 * Lists all uploaded parts for an in-flight multipart upload to verify manifest integrity.
 */
export const listParts = async (key, uploadId) => {
  const client = getS3Client()
  const bucket = getBucketName()

  const parts = []
  let partNumberMarker = undefined
  let isTruncated = true

  while (isTruncated) {
    const command = new ListPartsCommand({
      Bucket: bucket,
      Key: key,
      UploadId: uploadId,
      PartNumberMarker: partNumberMarker
    })

    const response = await client.send(command)
    if (response.Parts && response.Parts.length > 0) {
      for (const p of response.Parts) {
        parts.push({
          partNumber: p.PartNumber,
          etag: p.ETag || '', // Preserve exact ETag from B2
          size: p.Size
        })
      }
    }

    isTruncated = Boolean(response.IsTruncated)
    partNumberMarker = response.NextPartNumberMarker
  }

  return parts
}

/**
 * Completes a multipart upload on B2 using the verified, ordered manifest.
 */
export const completeMultipartUpload = async (key, uploadId, parts) => {
  const client = getS3Client()
  const bucket = getBucketName()

  // S3 requires parts sorted ascending by PartNumber
  // Format ETags with standard quotes as required by S3 XML without double-wrapping
  const sortedParts = [...parts]
    .sort((a, b) => Number(a.partNumber || a.PartNumber) - Number(b.partNumber || b.PartNumber))
    .map(p => {
      const pNum = Number(p.partNumber || p.PartNumber)
      let etag = String(p.etag || p.ETag || '').trim()
      if (!etag.startsWith('"')) {
        etag = `"${etag}"`
      }
      return {
        PartNumber: pNum,
        ETag: etag
      }
    })

  const command = new CompleteMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId,
    MultipartUpload: {
      Parts: sortedParts
    }
  })

  const response = await client.send(command)
  return {
    location: response.Location,
    bucket: response.Bucket,
    key: response.Key || key,
    etag: response.ETag || ''
  }
}

/**
 * Retrieves authoritative metadata and content length directly from B2.
 */
export const headObject = async (key) => {
  const client = getS3Client()
  const bucket = getBucketName()

  const command = new HeadObjectCommand({
    Bucket: bucket,
    Key: key
  })

  const response = await client.send(command)
  return {
    contentLength: response.ContentLength || 0,
    contentType: response.ContentType,
    etag: (response.ETag || '').replace(/^"|"$/g, ''),
    lastModified: response.LastModified
  }
}

/**
 * Aborts an active or abandoned multipart upload session on B2.
 */
export const abortMultipartUpload = async (key, uploadId) => {
  const client = getS3Client()
  const bucket = getBucketName()

  const command = new AbortMultipartUploadCommand({
    Bucket: bucket,
    Key: key,
    UploadId: uploadId
  })

  return await client.send(command)
}

/**
 * Lists all object versions and delete markers strictly matching an exact key.
 */
export const listObjectVersionsForExactKey = async (exactKey) => {
  const client = getS3Client()
  const bucket = getBucketName()

  const versions = []
  const deleteMarkers = []
  let keyMarker = undefined
  let versionIdMarker = undefined
  let isTruncated = true

  while (isTruncated) {
    const command = new ListObjectVersionsCommand({
      Bucket: bucket,
      Prefix: exactKey,
      KeyMarker: keyMarker,
      VersionIdMarker: versionIdMarker
    })

    const response = await client.send(command)

    // Strict filter to exact key
    if (response.Versions && response.Versions.length > 0) {
      for (const v of response.Versions) {
        if (v.Key === exactKey && v.VersionId) {
          versions.push({
            Key: v.Key,
            VersionId: v.VersionId
          })
        }
      }
    }

    if (response.DeleteMarkers && response.DeleteMarkers.length > 0) {
      for (const dm of response.DeleteMarkers) {
        if (dm.Key === exactKey && dm.VersionId) {
          deleteMarkers.push({
            Key: dm.Key,
            VersionId: dm.VersionId
          })
        }
      }
    }

    isTruncated = Boolean(response.IsTruncated)
    keyMarker = response.NextKeyMarker
    versionIdMarker = response.NextVersionIdMarker
  }

  return { versions, deleteMarkers }
}

/**
 * Permanently deletes all versions and delete markers for an exact key to release storage charges.
 * Inspects the per-object Errors array and verifies post-deletion absence.
 */
export const deleteExactKeyVersions = async (exactKey, b2UploadId = null) => {
  const client = getS3Client()
  const bucket = getBucketName()

  // 1. Abort multipart session if upload ID is provided
  if (b2UploadId) {
    try {
      await abortMultipartUpload(exactKey, b2UploadId)
    } catch (err) {
      console.warn(`[B2 Purge] Abort multipart upload for ${exactKey} returned:`, err.message)
    }
  }

  // 2. Abort any dangling incomplete multipart uploads matching this exact key
  try {
    const listMpCommand = new ListMultipartUploadsCommand({
      Bucket: bucket,
      Prefix: exactKey
    })
    const mpResp = await client.send(listMpCommand)
    if (mpResp.Uploads && mpResp.Uploads.length > 0) {
      for (const u of mpResp.Uploads) {
        if (u.Key === exactKey && u.UploadId) {
          try {
            await abortMultipartUpload(exactKey, u.UploadId)
            console.log(`[B2 Purge] Aborted lingering multipart upload: ${u.UploadId} for ${exactKey}`)
          } catch (abortErr) {
            console.warn(`[B2 Purge] Failed aborting upload ${u.UploadId}:`, abortErr.message)
          }
        }
      }
    }
  } catch (err) {
    console.warn(`[B2 Purge] ListMultipartUploads error for ${exactKey}:`, err.message)
  }

  // 3. Collect all object versions and delete markers
  const { versions, deleteMarkers } = await listObjectVersionsForExactKey(exactKey)
  const itemsToDelete = [...versions, ...deleteMarkers]

  if (itemsToDelete.length === 0) {
    // Check if simple headObject finds anything
    try {
      await headObject(exactKey)
      // If found, simple delete object
      const simpleDelCommand = new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: [{ Key: exactKey }],
          Quiet: false
        }
      })
      await client.send(simpleDelCommand)
    } catch (e) {
      // Only treat object as absent if error is explicitly 404 (NotFound / NoSuchKey)
      const isNotFound = e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404
      if (isNotFound) {
        return { success: true, deletedCount: 0 }
      }
      // Re-throw any authorization, network, 5xx, or unexpected storage errors
      throw e
    }
  } else {
    // Delete in chunks of 1000 (S3 limit)
    for (let i = 0; i < itemsToDelete.length; i += 1000) {
      const chunk = itemsToDelete.slice(i, i + 1000)
      const command = new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk,
          Quiet: false
        }
      })

      const response = await client.send(command)
      // Per-object error inspection
      if (response.Errors && response.Errors.length > 0) {
        const errDetails = response.Errors.map(e => `${e.Key} (${e.VersionId}): ${e.Message}`).join(', ')
        throw new Error(`B2 DeleteObjects failed for items: ${errDetails}`)
      }
    }
  }

  // 4. Post-deletion verification
  const check = await listObjectVersionsForExactKey(exactKey)
  if (check.versions.length > 0 || check.deleteMarkers.length > 0) {
    throw new Error(`Verification failed: ${check.versions.length} versions and ${check.deleteMarkers.length} delete markers remain for ${exactKey}`)
  }

  return {
    success: true,
    deletedCount: itemsToDelete.length
  }
}

/**
 * Generates an authorized 15-minute streaming URL with inline content-disposition.
 */
export const getPresignedStreamUrl = async (key, expiresInSeconds = 900) => {
  const client = getS3Client()
  const bucket = getBucketName()

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: 'inline'
  })

  return await getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}

/**
 * Generates an authorized 15-minute download URL with attachment content-disposition.
 */
export const getPresignedDownloadUrl = async (key, filename, expiresInSeconds = 900) => {
  const client = getS3Client()
  const bucket = getBucketName()

  const command = new GetObjectCommand({
    Bucket: bucket,
    Key: key,
    ResponseContentDisposition: `attachment; filename="${filename}"`
  })

  return await getSignedUrl(client, command, { expiresIn: expiresInSeconds })
}
