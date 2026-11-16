import {isIP} from 'node:net';

// Trust only explicitly configured peers; never accept a hop count or all-proxy flag.
export const parseTrustedProxies = value => {
  if (value === undefined || value === '') return false;
  if (typeof value !== 'string' || value.length > 4096) throw new Error('Invalid TRUSTED_PROXY_CIDRS.');
  const peers = value.split(',').map(peer => peer.trim());
  if (peers.length > 64 || peers.some(peer => {
    const parts = peer.split('/');
    const family = isIP(parts[0]);
    return !family || peer.includes('%') || parts.length > 2 ||
      (parts.length === 2 && (!/^\d{1,3}$/.test(parts[1]) || Number(parts[1]) < 1 || Number(parts[1]) > (family === 4 ? 32 : 128)));
  })) throw new Error('Invalid TRUSTED_PROXY_CIDRS.');
  return peers;
};
