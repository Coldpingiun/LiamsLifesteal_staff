/**
 * BloodBound SMP — Cloudflare Worker Proxy
 * ==========================================
 * This worker sits between your static HTML page and Discord's API.
 * It holds your Bot Token safely server-side so it never appears in the browser.
 *
 * SETUP (takes ~5 minutes):
 *  1. Go to https://dash.cloudflare.com → Workers & Pages → Create Worker
 *  2. Paste this entire file into the editor and click Save & Deploy
 *  3. Go to Settings → Variables → Add the following secret variables:
 *       BOT_TOKEN   →  your Discord bot token
 *       ALLOWED_ORIGIN → the URL of your staff portal (e.g. https://yoursite.com)
 *  4. Copy the Worker URL (e.g. https://bloodbound-proxy.yourname.workers.dev)
 *  5. Paste that URL into CONFIG.PROXY_URL in index.html
 *
 * DISCORD BOT SETUP:
 *  - In Discord Developer Portal → your app → Bot → copy Token → paste as BOT_TOKEN above
 *  - Under OAuth2 → Bot Permissions: check "Read Members" (permission int: 8589934592)
 *  - Invite URL: https://discord.com/api/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=8589934592&scope=bot
 *
 * The worker exposes one endpoint:
 *   GET /staff?guild=GUILD_ID
 *   Returns: JSON array of staff members with their top role name
 *
 * ROLE NAMES to match must match exactly what's in CONFIG.ROLE_MAP in index.html.
 */

const STAFF_ROLE_NAMES = ['Owner', 'Co-Owner', 'Developer', 'Admin', 'Moderator'];
const ROLE_PRIORITY    = ['Owner', 'Co-Owner', 'Developer', 'Admin', 'Moderator'];

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = env.ALLOWED_ORIGIN || '*';

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: corsHeaders(allowed),
      });
    }

    const url = new URL(request.url);

    // Only handle /staff endpoint
    if (url.pathname !== '/staff') {
      return new Response('Not found', { status: 404 });
    }

    const guildId = url.searchParams.get('guild');
    if (!guildId) {
      return json({ error: 'Missing guild parameter' }, 400, allowed);
    }

    try {
      // 1. Fetch all roles in the guild to build a name→id map
      const rolesRes = await discordFetch(`/guilds/${guildId}/roles`, env.BOT_TOKEN);
      if (!rolesRes.ok) {
        const err = await rolesRes.text();
        return json({ error: 'Failed to fetch roles', detail: err }, 502, allowed);
      }
      const allRoles = await rolesRes.json();
      const roleNameToId = {};
      const roleIdToName = {};
      for (const role of allRoles) {
        roleNameToId[role.name] = role.id;
        roleIdToName[role.id]   = role.name;
      }

      // Build set of staff role IDs
      const staffRoleIds = new Set(
        STAFF_ROLE_NAMES
          .map(name => roleNameToId[name])
          .filter(Boolean)
      );

      if (staffRoleIds.size === 0) {
        return json({ error: 'No matching staff roles found. Check STAFF_ROLE_NAMES in worker.js.' }, 400, allowed);
      }

      // 2. Paginate through guild members (max 1000 per request)
      let staffMembers = [];
      let after = '0';
      let page = 0;

      while (page < 10) { // safety limit: 10 000 members max
        const membersRes = await discordFetch(
          `/guilds/${guildId}/members?limit=1000&after=${after}`,
          env.BOT_TOKEN
        );
        if (!membersRes.ok) break;
        const members = await membersRes.json();
        if (!members.length) break;

        for (const m of members) {
          const memberRoleIds = m.roles || [];
          const hasStaffRole  = memberRoleIds.some(id => staffRoleIds.has(id));
          if (!hasStaffRole) continue;

          // Find top role by priority
          const memberRoleNames = memberRoleIds.map(id => roleIdToName[id]).filter(Boolean);
          let topRole = null;
          for (const r of ROLE_PRIORITY) {
            if (memberRoleNames.includes(r)) { topRole = r; break; }
          }

          staffMembers.push({
            id:          m.user.id,
            username:    m.user.username,
            discriminator: m.user.discriminator || '0',
            discord_tag: m.user.discriminator && m.user.discriminator !== '0'
              ? `${m.user.username}#${m.user.discriminator}`
              : `@${m.user.username}`,
            nick:        m.nick || null,
            avatar:      m.avatar || null,
            userAvatar:  m.user.avatar || null,
            joined_at:   m.joined_at,
            topRole,
            roles_resolved: memberRoleNames,
          });
        }

        after = members[members.length - 1].user.id;
        if (members.length < 1000) break;
        page++;
      }

      return json(staffMembers, 200, allowed);

    } catch (err) {
      return json({ error: 'Internal error', detail: err.message }, 500, allowed);
    }
  }
};

function discordFetch(path, token) {
  return fetch(`https://discord.com/api/v10${path}`, {
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json',
    },
  });
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };
}

function json(data, status = 200, origin = '*') {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...corsHeaders(origin),
    },
  });
}