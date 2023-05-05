export interface Env {
  CACHE_BUCKET: R2Bucket;
  IMAGE_ROOT: string;
  IMAGE_HOST?: string;
  CACHE_DURATION?: number;
}

const maxAge = 180 * 24 * 60 * 60; // 180 day default cache time

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      return await handleRequest(request, env, ctx);
    } catch (e: any) {
      return new Response(e.message, { status: 500 });
    }
  },
};

async function handleRequest(request: Request, env: Env, ctx: ExecutionContext) {
  const url = new URL(request.url);

  // Cloudflare-specific options are in the cf object.
  let resizeOptions:any = {}
  let type = 'jpeg'

  // Copy parameters from query string to request options.
  // You can implement various different parameters here.
  if (url.searchParams.has("fit")) resizeOptions.fit = url.searchParams.get("fit") || undefined
  if (url.searchParams.has("w")) resizeOptions.width = url.searchParams.get("w") || undefined
  if (url.searchParams.has("h")) resizeOptions.height = url.searchParams.get("h") || undefined
  if (url.searchParams.has("q")) resizeOptions.quality = url.searchParams.get("q") || undefined

  if(!resizeOptions.fit) {
    if (url.searchParams.get("enlarge") == 'true') resizeOptions.fit = 'cover'
  }

  // Your Worker is responsible for automatic format negotiation. Check the Accept header.
  const accept = request.headers.get("Accept") || ''
  if (/image\/avif/.test(accept)) {
    resizeOptions.format = 'avif'
    type = 'avif'
  } else if (/image\/webp/.test(accept)) {
    resizeOptions.format = 'webp'
    type = 'webp'
  }

  // Get URL of the original (full size) image to resize.
  const imageURLBase64 = url.searchParams.get("src")
  if (!imageURLBase64) return new Response('Missing "image" value', { status: 400 })
  const imageURL = atob(imageURLBase64)

  // Check that this is a valid URL
  const { hostname, pathname } = new URL(imageURL)
  try {
     if (!/\.(jpe?g|png|gif|webp)$/i.test(pathname)) {
      return new Response('Disallowed file extension', { status: 400 })
    }

    if (hostname !== 's3.medialoot.com') {
     return new Response('Invalid url for source images', { status: 403 })
    }
  } catch (err) {
    return new Response('Invalid "image" value', { status: 400 })
  }

  // set mime types if not already done
  if (/\.(png)$/i.test(pathname)) { type = 'png' }
  if (/\.(gif)$/i.test(pathname)) { type = 'gif' }
  

  const optionsKey = Object.entries(resizeOptions).map(([key, val]) => `${key}:${val}`).join('-')
  const cacheKey = 'test-' + imageURL + optionsKey
  const cache = caches.default;

  // Check whether the value is already available in the cache
  // if not, fetch it from R2, and store it in the cache
  let response = await cache.match(url.toString())
  if (response) return response
  console.log(`Cache miss for: ${cacheKey}.`)

  // Try to get it from R2
  let image = await (await env.CACHE_BUCKET.get(cacheKey))?.arrayBuffer()
  if (!image) {
    console.log(`R2 miss for: ${cacheKey}.`)

    // Get it from CF Images and resize per above options
    let cfImageRes: Response;
    try {
      // Build a request that passes through request headers
      const imageRequest = new Request(imageURL, {
        headers: request.headers
      })

      cfImageRes = await fetch(imageRequest, {
        cf: { image: resizeOptions }
      })
    } catch (e) {
      return new Response(null, { status: 404, statusText: 'Not Found' })
    }
    console.log(`Images fetch response: ${cfImageRes.status}`)
    image = await cfImageRes.arrayBuffer()

    // If we got it, add it to R2 after we finish
    if (image) {
      ctx.waitUntil(env.CACHE_BUCKET.put(cacheKey, image))
    }
  }

  // unable to fetch image from R2 or CF or URL, probably bad url
  if (!image) throw new Error('Unable to fetch image')

  // Prep the final response
  const headers = new Headers({
    // Cache it in the browser for your specified time
    'cache-control': `public, max-age=${env.CACHE_DURATION ?? maxAge}`,
    'access-control-allow-origin': '*',
    'content-security-policy': "default-src 'none'; navigate-to 'none'; form-action 'none'",
    'content-type': 'image/' + type
  })

  response = new Response(image, { headers })

  // Save the response to the cache for next time
  ctx.waitUntil(cache.put(url.toString(), response.clone()))

  return response
}
