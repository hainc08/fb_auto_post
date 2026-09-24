import { config } from '../config';
import { logger } from '../utils/logger';

/**
 * Facebook Graph API Service
 * Handles all interactions with the Facebook Graph API
 */

const FB_GRAPH = config.facebook.graphApiBase;
const FB_VERSION = config.facebook.graphApiVersion;

// Graph API responses are untyped JSON
const readJson = (response: Response): Promise<any> => response.json();

// ─── OAuth ──────────────────────────────────────

/**
 * Build Facebook OAuth login URL
 */
export function getLoginUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.facebook.appId,
    redirect_uri: config.facebook.redirectUri,
    scope: 'pages_manage_posts,pages_read_engagement,pages_show_list,pages_read_user_content',
    response_type: 'code',
    state,
  });

  return `${FB_GRAPH}/${FB_VERSION}/dialog/oauth?${params}`;
}

/**
 * Exchange authorization code for access token
 */
export async function exchangeCodeForToken(code: string): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const params = new URLSearchParams({
    client_id: config.facebook.appId,
    client_secret: config.facebook.appSecret,
    redirect_uri: config.facebook.redirectUri,
    code,
  });

  const response = await fetch(
    `${FB_GRAPH}/${FB_VERSION}/oauth/access_token?${params}`
  );

  if (!response.ok) {
    const error = await readJson(response);
    throw new Error(`Facebook OAuth error: ${JSON.stringify(error)}`);
  }

  const data = await readJson(response);
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in,
  };
}

/**
 * Exchange short-lived token for long-lived token
 */
export async function getLongLivedToken(shortToken: string): Promise<{
  accessToken: string;
  expiresIn: number;
}> {
  const params = new URLSearchParams({
    grant_type: 'fb_exchange_token',
    client_id: config.facebook.appId,
    client_secret: config.facebook.appSecret,
    fb_exchange_token: shortToken,
  });

  const response = await fetch(
    `${FB_GRAPH}/${FB_VERSION}/oauth/access_token?${params}`
  );

  if (!response.ok) {
    const error = await readJson(response);
    throw new Error(`Long-lived token exchange failed: ${JSON.stringify(error)}`);
  }

  const data = await readJson(response);
  return {
    accessToken: data.access_token,
    expiresIn: data.expires_in || 5184000, // ~60 days
  };
}

// ─── User & Pages ───────────────────────────────

export interface FacebookUserInfo {
  id: string;
  name: string;
  email?: string;
  picture?: { data: { url: string } };
}

export interface FacebookPageInfo {
  id: string;
  name: string;
  access_token: string;
  category: string;
  picture?: { data: { url: string } };
}

/**
 * Get Facebook user profile info
 */
export async function getUserInfo(accessToken: string): Promise<FacebookUserInfo> {
  const response = await fetch(
    `${FB_GRAPH}/${FB_VERSION}/me?fields=id,name,email,picture&access_token=${accessToken}`
  );

  if (!response.ok) {
    throw new Error('Failed to get Facebook user info');
  }

  return readJson(response);
}

/**
 * Get all pages the user manages
 */
export async function getUserPages(accessToken: string): Promise<FacebookPageInfo[]> {
  const response = await fetch(
    `${FB_GRAPH}/${FB_VERSION}/me/accounts?fields=id,name,access_token,category,picture&access_token=${accessToken}`
  );

  if (!response.ok) {
    const error = await readJson(response);
    throw new Error(`Failed to get user pages: ${JSON.stringify(error)}`);
  }

  const data = await readJson(response);
  return data.data || [];
}

// ─── Publishing ─────────────────────────────────

export interface PublishResult {
  postId: string;
  permalink?: string;
}

/**
 * Publish a text-only post to a Facebook Page
 */
export async function publishTextPost(
  pageId: string,
  pageAccessToken: string,
  message: string
): Promise<PublishResult> {
  logger.info('Publishing text post to Facebook', { pageId });

  const response = await fetch(`${FB_GRAPH}/${FB_VERSION}/${pageId}/feed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      access_token: pageAccessToken,
    }),
  });

  if (!response.ok) {
    const error = await readJson(response);
    logger.error('Facebook publish error:', error);
    throw new Error(`Facebook publish failed: ${JSON.stringify(error.error || error)}`);
  }

  const data = await readJson(response);
  return { postId: data.id };
}

/**
 * Upload a photo and publish with caption to a Facebook Page
 * This is the main publishing method used in the pipeline
 */
export async function publishPhotoPost(
  pageId: string,
  pageAccessToken: string,
  imageBuffer: Buffer,
  caption: string,
  mime: string = 'image/jpeg'
): Promise<PublishResult> {
  logger.info('Publishing photo post to Facebook', { pageId, captionLength: caption.length });

  // Create FormData for multipart upload
  const formData = new FormData();
  const blob = new Blob([imageBuffer], { type: mime });
  formData.append('source', blob, `post-image.${mime.split('/')[1] ?? 'jpg'}`);
  formData.append('message', caption);
  formData.append('access_token', pageAccessToken);

  const response = await fetch(`${FB_GRAPH}/${FB_VERSION}/${pageId}/photos`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const error = await readJson(response);
    logger.error('Facebook photo publish error:', error);
    throw new Error(`Facebook photo publish failed: ${JSON.stringify(error.error || error)}`);
  }

  const data = await readJson(response);
  const photoId = data.id;
  const postId = data.post_id || data.id;

  // Get permalink
  let permalink: string | undefined;
  try {
    const permalinkRes = await fetch(
      `${FB_GRAPH}/${FB_VERSION}/${postId}?fields=permalink_url&access_token=${pageAccessToken}`
    );
    if (permalinkRes.ok) {
      const permalinkData = await readJson(permalinkRes);
      permalink = permalinkData.permalink_url;
    }
  } catch {
    // Permalink is optional, don't fail
  }

  return { postId, permalink };
}

/**
 * Publish a post with an image URL (instead of uploading)
 */
export async function publishPhotoUrlPost(
  pageId: string,
  pageAccessToken: string,
  imageUrl: string,
  caption: string
): Promise<PublishResult> {
  logger.info('Publishing photo URL post to Facebook', { pageId, imageUrl });

  const response = await fetch(`${FB_GRAPH}/${FB_VERSION}/${pageId}/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: imageUrl,
      message: caption,
      access_token: pageAccessToken,
    }),
  });

  if (!response.ok) {
    const error = await readJson(response);
    throw new Error(`Facebook photo URL publish failed: ${JSON.stringify(error.error || error)}`);
  }

  const data = await readJson(response);
  return { postId: data.post_id || data.id };
}

// ─── Insights ───────────────────────────────────

export interface PostInsights {
  impressions: number;
  reach: number;
  engagement: number;
  reactions: number;
  comments: number;
  shares: number;
}

/**
 * Get insights/metrics for a published post
 */
export async function getPostInsights(
  postId: string,
  pageAccessToken: string
): Promise<PostInsights> {
  const metrics = 'post_impressions,post_engaged_users,post_reactions_by_type_total';

  const response = await fetch(
    `${FB_GRAPH}/${FB_VERSION}/${postId}/insights?metric=${metrics}&access_token=${pageAccessToken}`
  );

  if (!response.ok) {
    logger.warn('Failed to get post insights', { postId });
    return {
      impressions: 0,
      reach: 0,
      engagement: 0,
      reactions: 0,
      comments: 0,
      shares: 0,
    };
  }

  const data = await readJson(response);
  const insightsMap: Record<string, number> = {};

  for (const item of data.data || []) {
    insightsMap[item.name] = item.values?.[0]?.value || 0;
  }

  return {
    impressions: insightsMap.post_impressions || 0,
    reach: insightsMap.post_impressions_unique || 0,
    engagement: insightsMap.post_engaged_users || 0,
    reactions: 0,
    comments: 0,
    shares: 0,
  };
}
