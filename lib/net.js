import { networkInterfaces } from 'node:os';

// IPv4 addresses this machine can be reached on, excluding loopback. A Docker
// or WSL adapter usually shows up here too, so the label keeps the interface name.
export function lanAddresses() {
  const out = [];
  const ifaces = networkInterfaces();
  for (const [name, list] of Object.entries(ifaces)) {
    for (const info of list || []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      out.push({ name, address: info.address, netmask: info.netmask, cidr: info.cidr });
    }
  }
  return out;
}

// What a browser could actually type to reach this process, given the bind host.
// Binding 0.0.0.0 accepts every interface, so every LAN address is listed; a
// 127.0.0.1 bind only has loopback, and listing LAN URLs there would be a lie.
export function reachableUrls(host, port) {
  const loopback = `http://127.0.0.1:${port}`;
  const local = host === '0.0.0.0' || host === '::'
    ? [loopback, `http://localhost:${port}`]
    : [`http://${host}:${port}`];

  const lan = host === '0.0.0.0' || host === '::'
    ? lanAddresses().map((i) => ({ url: `http://${i.address}:${port}`, name: i.name }))
    : [];

  return { local, lan, openToNetwork: host === '0.0.0.0' || host === '::' };
}

// Windows blocks inbound TCP on a random port until a firewall rule exists, so
// the LAN URL is printed together with the exact command that makes it work.
export function windowsFirewallCommand(port) {
  const rule = 'DevChat (TCP)';
  return `netsh advfirewall firewall add rule name="${rule}" dir=in action=allow protocol=TCP localport=${port}`;
}
