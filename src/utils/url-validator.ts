/**
 * URL validation utility — blocks dangerous protocols and private/loopback addresses.
 */

export interface ValidateUrlOptions {
  /** Allow file: protocol (default: false). Only enable for local/trusted contexts. */
  allowFile?: boolean;
  /** Block private/loopback IP addresses (default: false). Enable for public-facing deployments. */
  blockPrivate?: boolean;
}

// RFC 1918 + loopback + link-local ranges
const PRIVATE_IP_PATTERNS = [
  /^127\./,                          // 127.0.0.0/8
  /^10\./,                           // 10.0.0.0/8
  /^172\.(1[6-9]|2\d|3[01])\./,     // 172.16.0.0/12
  /^192\.168\./,                     // 192.168.0.0/16
  /^169\.254\./,                     // link-local
  /^0\./,                            // 0.0.0.0/8
];

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  '0.0.0.0',
  '[::1]',
  '[::0]',
  '[0:0:0:0:0:0:0:1]',
  '[0:0:0:0:0:0:0:0]',
]);

export function validateUrl(url: string, options: ValidateUrlOptions = {}): { valid: true; parsed: URL } | { valid: false; reason: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { valid: false, reason: 'Invalid URL format' };
  }

  const allowed = ['http:', 'https:'];
  if (options.allowFile) allowed.push('file:');

  if (!allowed.includes(parsed.protocol)) {
    const names = allowed.map(p => p.replace(':', '')).join('/');
    return { valid: false, reason: `Protocol not allowed: ${parsed.protocol} (only ${names})` };
  }

  // file: URLs don't have hostnames, skip IP checks
  if (parsed.protocol === 'file:') {
    return { valid: true, parsed };
  }

  if (!options.blockPrivate) {
    return { valid: true, parsed };
  }

  const hostname = parsed.hostname;

  if (PRIVATE_HOSTNAMES.has(hostname.toLowerCase())) {
    return { valid: false, reason: `Access to private/loopback address denied: ${hostname}` };
  }

  for (const pattern of PRIVATE_IP_PATTERNS) {
    if (pattern.test(hostname)) {
      return { valid: false, reason: `Access to private/loopback address denied: ${hostname}` };
    }
  }

  // IPv6 private ranges: link-local, unique-local, IPv4-mapped private addresses
  const lowerHost = hostname.toLowerCase();
  if (
    lowerHost.startsWith('[fe80:') ||   // link-local
    lowerHost.startsWith('[fc') ||       // unique-local
    lowerHost.startsWith('[fd') ||       // unique-local
    lowerHost.startsWith('[::ffff:')     // IPv4-mapped IPv6 (e.g. [::ffff:127.0.0.1])
  ) {
    // For IPv4-mapped IPv6, extract the embedded IPv4 and re-check
    if (lowerHost.startsWith('[::ffff:')) {
      const embeddedIp = hostname.slice(8, -1); // strip [::ffff: and ]
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(embeddedIp)) {
          return { valid: false, reason: `Access to private address denied (IPv4-mapped IPv6): ${hostname}` };
        }
      }
    } else {
      return { valid: false, reason: `Access to private IPv6 address denied: ${hostname}` };
    }
  }

  // Block numeric IP representations (decimal, octal, hex) that could bypass regex checks
  // e.g. 0x7f000001, 2130706433, 0177.0.0.1
  if (/^0x[0-9a-f]+$/i.test(hostname) || /^\d+$/.test(hostname) || /^0\d/.test(hostname)) {
    return { valid: false, reason: `Numeric IP notation not allowed: ${hostname}` };
  }

  return { valid: true, parsed };
}
