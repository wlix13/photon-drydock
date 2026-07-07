# Container Registry in Workers

This repository contains a container registry implementation in Workers that uses R2.

It supports all pushing and pulling workflows. It also supports
Username/Password and public key JWT based authentication.

### Deployment

You have to install all the dependencies with [pnpm](https://pnpm.io/installation) (other package managers may work, but only pnpm is supported.)

```bash
pnpm install
```

After installation, there are a few steps to actually deploy the registry into production:

1. Create your own wrangler config file based on the example files in this repo.

Cloudflare recommends [`wrangler.jsonc`](https://developers.cloudflare.com/workers/wrangler/configuration/) for new projects, but `wrangler.toml` is also supported. Pick whichever you prefer:

```bash
# JSONC (recommended)
$ cp wrangler.example.jsonc wrangler.jsonc

# or TOML
$ cp wrangler.example.toml wrangler.toml
```

1. In your config, replace `registry.example.com` in `routes` with your own (sub)domain. The domain's zone must be on your Cloudflare account; Cloudflare creates the DNS record for you on deploy. A custom domain is required for [edge caching](#edge-caching) — if you'd rather use the default `*.workers.dev` domain, remove the `routes` line and set `workers_dev` to `true` (the registry works, but nothing is cached).

2. Create the R2 bucket (the config already references it by name):

```bash
npx wrangler r2 bucket create r2-registry
```

3. Set the registry credentials:

```bash
npx wrangler secret put USERNAME --env production
npx wrangler secret put PASSWORD --env production
```

4. Deploy your image registry:

```bash
pnpm run deploy
```

Your registry is now live on your domain. It will refuse any requests until the credentials from step 4 are set.

### Adding username password based authentication

Set the USERNAME and PASSWORD as secrets with `npx wrangler secret put USERNAME --env production` and `npx wrangler secret put PASSWORD --env production`.

### Adding JWT authentication with public key

You can add a base64 encoded JWT public key to verify passwords (or token) that are signed by the private key.
`npx wrangler secret put JWT_REGISTRY_TOKENS_PUBLIC_KEY --env production`

The token carries its own capabilities (`pull` and/or `push`), which are checked per request.

**Multiple keys:** both `JWT_REGISTRY_TOKENS_PUBLIC_KEY` and `READONLY_JWT_REGISTRY_TOKENS_PUBLIC_KEY` accept a comma-separated list of base64-encoded public keys, so you can trust several signing keys at once and rotate them independently. A token is accepted if any configured key verifies its signature.

**Read-only keys:** keys set in `READONLY_JWT_REGISTRY_TOKENS_PUBLIC_KEY` cap every token they
sign to `pull`, regardless of the capabilities the token claims. Hand a read-only signing key to a
party that should only ever pull, and it can never be used to push — even if the token requests it.
`npx wrangler secret put READONLY_JWT_REGISTRY_TOKENS_PUBLIC_KEY --env production`

**Combined with username/password:** JWT and username/password authentication can be enabled at the
same time. When both are configured, a request is accepted if _either_ method verifies it — so, for example, humans can log in with a username/password while CI systems present signed tokens.

#### Generating keys and tokens

A small CLI (`scripts/jwt.mjs`, no build step required) generates the keypair and signs tokens.

First, generate a keypair once and set the **public** key as a secret:

```bash
pnpm jwt genkey
# Set the printed public key as a secret. Use JWT_REGISTRY_TOKENS_PUBLIC_KEY for full access,
# or READONLY_JWT_REGISTRY_TOKENS_PUBLIC_KEY to force every token from this key to pull-only:
npx wrangler secret put JWT_REGISTRY_TOKENS_PUBLIC_KEY --env production
```

Then sign tokens with the **private** key — read-only or full access:

```bash
# full access (pull + push) — the default
pnpm jwt sign --private <base64-private-key> --full

# read-only (pull only), expiring in 30 minutes
pnpm jwt sign --private <base64-private-key> --readonly --exp 30
```

The printed token is used as the **password** when logging in (any username works):

```bash
echo "<token>" | docker login --username v0 --password-stdin $REGISTRY_URL
```

There are two independent ways to get a read-only credential: sign a token with `--readonly`
(the token itself only claims `pull`), or register the signing key under
`READONLY_JWT_REGISTRY_TOKENS_PUBLIC_KEY` (which caps _any_ token from that key to `pull`, even one
signed with `--full`). Run `pnpm jwt` with no arguments for the full list of options.

### Using with Docker

You can use this registry with Docker to push and pull images.

Example using `docker push` and `docker pull`:

```bash
export REGISTRY_URL=your-url-here

# Replace $PASSWORD and $USERNAME with the actual credentials
echo $PASSWORD | docker login --username $USERNAME --password-stdin $REGISTRY_URL
docker pull ubuntu:latest
docker tag ubuntu:latest $REGISTRY_URL/ubuntu:latest
docker push $REGISTRY_URL/ubuntu:latest

# Check that pulls work
docker rmi ubuntu:latest $REGISTRY_URL/ubuntu:latest
docker pull $REGISTRY_URL/ubuntu:latest
```

### Configuring Pull fallback

You can configure the R2 registry to fallback to another registry if
it doesn't exist in your R2 bucket. It will download from the registry
and copy it into the R2 bucket. In the next pull it will be able to pull it directly from R2.

This is very useful for migrating from one registry to `serverless-registry`.

It supports both Basic and Bearer authentications as explained in the
[registry spec](https://distribution.github.io/distribution/spec/auth/token/).

In your wrangler config file:

```jsonc
// wrangler.jsonc
"env": {
  "production": {
    "vars": {
      "REGISTRIES_JSON": "[{ \"registry\": \"https://url-to-other-registry\", \"password_env\": \"REGISTRY_TOKEN\", \"username\": \"username-to-use\" }]"
    }
  }
}
```

```toml
# wrangler.toml
[env.production.vars]
REGISTRIES_JSON = "[{ \"registry\": \"https://url-to-other-registry\", \"password_env\": \"REGISTRY_TOKEN\", \"username\": \"username-to-use\" }]"
```

Set as a secret the registry token of the registry you want to setup
pull fallback in.

For example [gcr](https://cloud.google.com/artifact-registry/docs/reference/docker-api):

```
cat ./registry-service-credentials.json | base64 | npx wrangler secret put REGISTRY_TOKEN --env production
```

[Github](https://github.com/settings/tokens) for example uses a simple token that you can copy.

```
echo $GITHUB_TOKEN | npx wrangler secret put REGISTRY_TOKEN --env production
```

The trick is always looking for how you would login in Docker for
the target registry and setup the credentials.

**Never put a registry password/token inside your wrangler config file, please always use `wrangler secrets put`**

#### GitHub Container Registry (ghcr.io)

The example wrangler configs ship with anonymous `ghcr.io` fallback enabled by default, which works for public
images:

```jsonc
"REGISTRIES_JSON": "[{ \"registry\": \"https://ghcr.io\" }]"
```

For private images, use a [GitHub personal access token](https://github.com/settings/tokens) with the
`read:packages` scope:

```jsonc
"REGISTRIES_JSON": "[{ \"registry\": \"https://ghcr.io\", \"username\": \"<your-github-username>\", \"password_env\": \"GHCR_TOKEN\" }]"
```

```bash
echo $GITHUB_PAT | npx wrangler secret put GHCR_TOKEN --env production
```

#### Docker Hub

You can also use docker.io with anonymous authentication:

```jsonc
// wrangler.jsonc
"REGISTRIES_JSON": "[{ \"registry\": \"https://index.docker.io/\" }]"
```

```toml
# wrangler.toml
REGISTRIES_JSON = "[{ \"registry\": \"https://index.docker.io/\" }]"
```

You can also set your `docker.io` credentials in the configuration to not have any rate-limiting.

### Edge caching

The registry caches manifest and blob downloads on Cloudflare's edge with the [Cache API](https://developers.cloudflare.com/workers/runtime-apis/cache/), reducing both R2 read operations and
pull latency. It is enabled by default and has the following semantics:

- Authentication is always enforced before the cache is consulted; responses are only cached after a successful authenticated request, and the cache is per data center.
- Content addressed by digest (blobs, and manifests requested by digest) is immutable and cached for up to 7 days.
- Manifests requested by tag are cached for up to 60 seconds. Pushing or deleting a tag invalidates the cache immediately in the data center that handled the request (deleting a manifest by digest also purges the cache entries of its tag aliases); other data centers can serve the previous tag for at most 60 seconds.
- With [pull fallback](#configuring-pull-fallback) configured, a cached response also postpones retries of the background copy into R2 in that data center until the TTL expires; other data centers still trigger the copy on their first pull.
- Content removed by the garbage collector can still be served from data centers that cached it until the TTL expires (up to 7 days). If you need deleted content gone everywhere immediately, use a [cache purge](https://developers.cloudflare.com/cache/how-to/purge-cache/) on your zone.
- Responses to cacheable endpoints include an `X-Registry-Cache: HIT|MISS` header for observability.

The Cache API is a no-op on `*.workers.dev` domains, so edge caching only takes effect when the Worker runs on a [custom domain or route](https://developers.cloudflare.com/workers/configuration/routing/).

To disable it, set the variable in your wrangler config file:

```jsonc
// wrangler.jsonc
"vars": { "EDGE_CACHE": "off" }
```

```toml
# wrangler.toml
[env.production.vars]
EDGE_CACHE = "off"
```

### Known limitations

Right now there is some limitations with this container registry.

- Pushing with docker is limited to images that have layers of maximum size 500MB. Refer to maximum request body sizes in your Workers plan.
- To circumvent that limitation, you can either manually interact with the R2 bucket to upload the layer or take a
  peek at the `./push` folder for some inspiration on how can you push big layers.
- If you use `npx wrangler dev` and push to the R2 registry with docker, the R2 registry will have to buffer the request on the Worker.

## License

The project is licensed under the [Apache License](https://opensource.org/licenses/apache-2.0/).

### Contribution

See `CONTRIBUTING.md` for contributing to the project.
