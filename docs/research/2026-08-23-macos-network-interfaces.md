# macOS Network Interfaces - Enumeration, Noise, and What "Pick an Interface" Binds

2026-08-23. Resolves wayfinder research ticket **#22** (parent map: **#19**). Unblocks **#32**.

**The ask, in Rocket's words:** *"I want to pick the network interface this is listening to,
or sending and receiving on. Whatever network interfaces are available that would accept IP
traffic. I'm sure there is a process in which you can filter out any of the noise from the
network interfaces."*

**Method.** Everything under "Measured" was run on the target machine on 2026-08-23 and the
output is pasted verbatim. Everything under "Source" is quoted from the code or docs that own
the behaviour. Labels: **[FACT]** = measured here or quoted from a primary source.
**[JUDGEMENT]** = a call. **[UNRESOLVED]** = not settled.

**Machine under test:** macOS 26.6.2 (build 25G83), Node **v26.7.0**. Wired `en0` is the
primary; a USB-C dock NIC (`en11`), Wi-Fi (`en1`) and a Tailscale tunnel (`utun4`) are also
carrying addresses, which makes this an unusually good specimen - four independent live paths
plus loopback.

---

## Verdict summary

| Question | Answer |
|---|---|
| How many interfaces does the kernel have? | **29** |
| How many does `os.networkInterfaces()` return? | **11.** It only returns interfaces that are UP **and** RUNNING **and** carry an address. 18 vanish for free. |
| How many survive a link-local filter? | **5** - `lo0`, `en0`, `en1`, `en11`, `utun4`. That is the picker. |
| Is `os.networkInterfaces()` cached? | **No.** Fresh `getifaddrs(3)` on every call, no memoisation at any layer. |
| Does `internal` mean "not worth offering"? | **No.** `internal` is *exactly* `IFF_LOOPBACK` and nothing else. It is the D-24 admin path, not noise. |
| Does a Node server bind an interface? | **No. It binds an address.** Node exposes no `IP_BOUND_IF` equivalent. |
| What should the config store? | **A mode, not an address.** `all` (default) / `loopback` / a pinned address with a named interface as a hint. |
| What breaks if you store a bare address? | **The service will not boot.** Measured: `EADDRNOTAVAIL` on a stale address. |
| Hidden cost of picking one LAN interface | **It kills loopback.** Measured: bound to `10.42.14.189`, `127.0.0.1` is `ECONNREFUSED`. D-24 local admin dies with it. |

---

## 1. What Node actually exposes

### 1.1 Source of truth

`os.networkInterfaces()` → `node_os.cc:GetInterfaceAddresses` → `uv_interface_addresses()` →
`getifaddrs(3)`.

**[FACT]** Node docs, `os.networkInterfaces()`: *"Returns an object containing network
interfaces **that have been assigned a network address**."* Fields are `address`, `netmask`,
`family` (`"IPv4"`/`"IPv6"` as a **string** since v18.4.0 - it was a number in v18.0.0), `mac`,
`internal`, `cidr`, and `scopeid` (IPv6 only).
Source: <https://nodejs.org/docs/latest-v24.x/api/os.html>

**[FACT]** `internal` is defined by libuv as one bit and nothing more:

```c
address->is_internal = !!(ent->ifa_flags & IFF_LOOPBACK);
```

**[FACT]** The filter that drops interfaces, verbatim from `libuv/src/unix/bsd-ifaddrs.c`
(the file macOS compiles):

```c
static int uv__ifaddr_exclude(struct ifaddrs *ent, int exclude_type) {
  if (!((ent->ifa_flags & IFF_UP) && (ent->ifa_flags & IFF_RUNNING)))
    return 1;
  if (ent->ifa_addr == NULL)
    return 1;
#if !defined(__CYGWIN__) && !defined(__MSYS__) && !defined(__GNU__)
  if (exclude_type == UV__EXCLUDE_IFPHYS)
    return (ent->ifa_addr->sa_family != AF_LINK);
#endif
#if defined(__APPLE__) || defined(__FreeBSD__) || defined(__DragonFly__) || \
    defined(__HAIKU__)
  if (ent->ifa_addr->sa_family == AF_LINK)
    return 1;
#endif
  return 0;
}
```

Source: <https://github.com/libuv/libuv/blob/v1.x/src/unix/bsd-ifaddrs.c>

Three consequences fall straight out of that code:

- **A DOWN interface does not appear at all.** It is not returned with an empty array or a
  flag - the name is simply absent from the object. There is no "this interface exists but is
  down" state in the Node API. **[FACT, source-derived]**
- **An interface with no address does not appear**, even when UP and RUNNING.
- **`internal` cannot tell you "virtual", "safe", or "local".** `utun4` (a VPN tunnel) and
  `awdl0` (AirDrop) both report `internal: false`, same as real Ethernet.

### 1.2 Live or cached? Live. **[FACT]**

- `libuv` calls `getifaddrs(&addrs)` on every invocation of `uv_interface_addresses`; there
  is no cache in the function.
- `node_os.cc:GetInterfaceAddresses` calls `uv_interface_addresses` on every invocation and
  frees the result before returning; no memoisation.
- Measured - two back-to-back calls return **different object identities** with equal content,
  confirming no shared cached object is handed out:

```
same object ref: false | same lo0 array ref: false | deep equal: true
```

**[JUDGEMENT]** It is live, but it is a **poll, not a subscription**. Node gives you no
change notification. If the admin UI shows an interface list, it must re-call on each render
or on a timer; there is no event to hook.

### 1.3 Measured output on this machine **[FACT]**

`ifconfig -a` lists **29** interfaces:

```
lo0 gif0 stf0 anpi0 anpi2 anpi1 anpi3 en0 en6 en7 en8 en11 en9 en2 en3 en4 en5 en10
ap1 en1 awdl0 llw0 bridge0 pktap0 utun0 utun1 utun2 utun3 utun4
```

`Object.keys(os.networkInterfaces())` returns **11**:

```
lo0 en0 en11 en1 awdl0 llw0 utun0 utun1 utun2 utun3 utun4
```

Confirmed absent from Node's view: `anpi0`, `bridge0`, `gif0`, `ap1`, `en2`, `pktap0` - all
`false` on an `in` check.

Full `os.networkInterfaces()` output, verbatim (trimmed to one representative record per
shape; the addresses are this machine's real ones):

```json
{
  "lo0": [
    { "address": "127.0.0.1", "netmask": "255.0.0.0", "family": "IPv4",
      "mac": "00:00:00:00:00:00", "internal": true, "cidr": "127.0.0.1/8" },
    { "address": "::1", "netmask": "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "family": "IPv6", "mac": "00:00:00:00:00:00", "internal": true,
      "cidr": "::1/128", "scopeid": 0 },
    { "address": "fe80::1", "netmask": "ffff:ffff:ffff:ffff::", "family": "IPv6",
      "mac": "00:00:00:00:00:00", "internal": true, "cidr": "fe80::1/64", "scopeid": 1 }
  ],
  "en0": [
    { "address": "fe80::8fa:c29a:af2:e60a", "netmask": "ffff:ffff:ffff:ffff::",
      "family": "IPv6", "mac": "9c:76:0e:46:bb:8d", "internal": false,
      "cidr": "fe80::8fa:c29a:af2:e60a/64", "scopeid": 8 },
    { "address": "10.42.14.189", "netmask": "255.255.240.0", "family": "IPv4",
      "mac": "9c:76:0e:46:bb:8d", "internal": false, "cidr": "10.42.14.189/20" }
  ],
  "en11": [ /* fe80::1c56:.../64 scopeid 12, fd7b:3b1d:e25e:4632:ca7:.../64 scopeid 0,
              10.42.13.86/20 - mac 00:23:a4:0a:14:e8 */ ],
  "en1":  [ /* fe80::145a:.../64 scopeid 20, fd7b:3b1d:e25e:4632:1475:.../64 scopeid 0,
              10.42.11.104/20 - mac 9c:76:0e:36:5e:6f */ ],
  "awdl0": [
    { "address": "fe80::5c60:faff:fe7a:88f0", "netmask": "ffff:ffff:ffff:ffff::",
      "family": "IPv6", "mac": "5e:60:fa:7a:88:f0", "internal": false,
      "cidr": "fe80::5c60:faff:fe7a:88f0/64", "scopeid": 21 }
  ],
  "llw0":  [ /* identical address and MAC to awdl0, scopeid 22 */ ],
  "utun0": [ /* fe80::8dc6:d0b8:b3bb:b1d7/64 scopeid 25, mac 00:00:00:00:00:00 */ ],
  "utun1": [ /* fe80::c0be:7394:9b1a:90c3/64 scopeid 26 */ ],
  "utun2": [ /* fe80::40e1:4e1a:d29a:5207/64 scopeid 27 */ ],
  "utun3": [ /* fe80::ce81:b1c:bd2c:69e/64 scopeid 28 */ ],
  "utun4": [
    { "address": "fe80::9e76:eff:fe46:bb8d", "family": "IPv6", "internal": false,
      "cidr": "fe80::9e76:eff:fe46:bb8d/64", "scopeid": 29 },
    { "address": "100.92.197.95", "netmask": "255.255.255.255", "family": "IPv4",
      "mac": "00:00:00:00:00:00", "internal": false, "cidr": "100.92.197.95/32" },
    { "address": "fd7a:115c:a1e0::9936:c560", "netmask": "ffff:ffff:ffff::",
      "family": "IPv6", "mac": "00:00:00:00:00:00", "internal": false,
      "cidr": "fd7a:115c:a1e0::9936:c560/48", "scopeid": 0 }
  ]
}
```

### 1.4 Two field traps **[FACT]**

- **`mac` is `00:00:00:00:00:00` for every tunnel and for loopback.** It is not a usable
  identity key. `awdl0` and `llw0` share both a MAC *and* an IPv6 address
  (`5e:60:fa:7a:88:f0`, `fe80::5c60:faff:fe7a:88f0`) - so neither MAC nor address is a unique
  key across interfaces.
- **`scopeid` is not the zone you need to bind a link-local address.** See §3.3 - only the
  interface *name* works.

---

## 2. What the noise actually is - all 29 classified

Apple's own position, from a DTS engineer on the developer forums:

> **[FACT]** *"BSD interface names are not considered API. There's no guarantee, for example,
> that an iPhone's Wi-Fi interface is `en0`."*
> — <https://developer.apple.com/forums/thread/734293>

> **[FACT]** *"Don't attempt to do that. Some of these interfaces are used for stuff that's
> vital to the internal operation of macOS, for example, communication between the main CPU
> and various co-processors."* … *"`networksetup -listallhardwareports` gives you the BSD name
> of each user-visible interface."*
> — <https://developer.apple.com/forums/thread/820120>

That second quote is the whole answer to `anpi*`, and it is also the answer to the naming
problem: **Apple ships the allow-list.** `networksetup -listallhardwareports` is the
supported way to know which interfaces a human is meant to see.

| Interface | Count here | What it is | In Node? | Verdict |
|---|---|---|---|---|
| `lo0` | 1 | Loopback. `127.0.0.1`, `::1`, `fe80::1`. `IFF_LOOPBACK` → `internal: true`. | **yes** | **Not noise.** The D-24 local-admin path. Always offer. |
| `en0` | 1 | Built-in Ethernet (`networksetup`: "Ethernet"). `10.42.14.189/20`, default route. | **yes** | Real. Offer. |
| `en1` | 1 | Wi-Fi (`networksetup`: "Wi-Fi"). `10.42.11.104/20` via DHCP. | **yes** | Real. Offer. |
| `en11` | 1 | USB-C dock NIC, `networksetup`: "RTL8156B". `10.42.13.86/20`. | **yes** | Real. Offer. |
| `en10` | 1 | Second dock NIC, "Plugable USBC-6950UE". UP+RUNNING, `media: autoselect (none)`, no address. | no | Unplugged. Dropped for free. |
| `en6`–`en9` | 4 | "Ethernet Adapter (enN)" - dock/virtual NIC slots, `status: inactive`, no address. | no | Dropped for free. |
| `en2`–`en5` | 4 | Thunderbolt 1–4 ports (`PROMISC`, members of `bridge0`), no address. | no | Dropped for free. |
| `bridge0` | 1 | Thunderbolt Bridge; bridges `en2..en5`. UP+RUNNING but `status: inactive`, no address. | no | Dropped for free. Would appear if a TB cable were connected to another Mac. |
| `anpi0`–`anpi3` | 4 | Apple internal co-processor links. `media: none`, `status: inactive`, no address. Apple: "vital to the internal operation of macOS". | no | Pure noise. Dropped for free. |
| `ap1` | 1 | Wi-Fi AP/Personal-Hotspot pseudo-interface, paired with `en1`. UP+RUNNING, no address. | no | Dropped for free. Would gain `192.168.2.1` if hotspot were on. |
| `awdl0` | 1 | Apple Wireless Direct Link - AirDrop, AirPlay, Continuity. **Link-local IPv6 only**, `status: active`. | **yes** | **Noise, and must be filtered by rule** - `internal` is `false` and it is genuinely UP. Filtered by §3's link-local rule. |
| `llw0` | 1 | "Low-latency WLAN" companion to `awdl0`. Same MAC, same fe80 address, link-local only. | **yes** | Same as `awdl0`. |
| `utun0`–`utun3` | 4 | System-owned tunnels (IKEv2/Back-to-My-Mac/iCloud Private Relay family). Distinct MTUs (1500/1380/2000/1000). **Link-local IPv6 only** - no bindable address. `scutil --nc list` shows no user VPN service behind them. | **yes** | Filtered by the link-local rule, without ever needing a `utun` name match. |
| `utun4` | 1 | **Tailscale.** `100.92.197.95/32` (CGNAT `100.64/10`) and `fd7a:115c:a1e0::/48` - Tailscale's documented ranges. `scutil --nc list` confirms: `VPN (io.tailscale.ipn.macos) "Tailscale"`. Carries a default route. | **yes** | **Not noise.** This is precisely the "a VPN tunnel might be where someone wants to listen" case, and it is live on this machine today. |
| `gif0` | 1 | Generic tunnel stub. `flags=8010<POINTOPOINT,MULTICAST>` - **not UP**. | no | Dropped by the `IFF_UP` test. |
| `stf0` | 1 | 6to4 stub. `flags=0<>` - nothing set. | no | Dropped by the `IFF_UP` test. |
| `pktap0` | 1 | Packet-tap pseudo-device for `tcpdump`. `flags=1<UP>`, not RUNNING, mtu 0. | no | Dropped by the `IFF_RUNNING` test. |

**The headline: 18 of the 29 are filtered by libuv before your code sees them.** The only
noise that survives into `os.networkInterfaces()` is `awdl0`, `llw0`, and `utun0`–`utun3` -
**six entries, and all six are link-local-IPv6-only.** One rule kills all of them.

---

## 3. The filtering heuristic - and where it is wrong

### 3.1 The rule

Applied to each **address record**, not each interface:

1. Start from `os.networkInterfaces()`. (Free: UP + RUNNING + has-an-address.)
2. **Drop IPv6 link-local, `fe80::/10`** (`/^fe[89ab]/i`). Justification is mechanical, not
   taxonomic: it is unbindable without a zone id, and a zoned link-local address cannot be
   typed into a browser or an ESP32 config. It is not a URL.
3. **Drop IPv4 link-local, `169.254.0.0/16`.** Self-assigned; means DHCP failed. None present
   today.
4. **Never drop loopback.** Label it, sort it first, and mark it "this Mac only". D-24.
5. **Do not filter by name. Annotate by name.** Join `networksetup -listallhardwareports` for
   the human label, and `scutil --nc list` for VPN services. Anything in neither list is still
   offered, just labelled "unnamed".

Rule 5 is the load-bearing one: a name-based *filter* would have deleted Tailscale.

### 3.2 Measured result of applying it **[FACT]**

Dropped (11 records, all link-local):

```
lo0   fe80::1                     en0   fe80::8fa:c29a:af2:e60a
en11  fe80::1c56:e3ce:9f59:7730   en1   fe80::145a:d254:a2ba:34d1
awdl0 fe80::5c60:faff:fe7a:88f0   llw0  fe80::5c60:faff:fe7a:88f0
utun0 fe80::8dc6:d0b8:b3bb:b1d7   utun1 fe80::c0be:7394:9b1a:90c3
utun2 fe80::40e1:4e1a:d29a:5207   utun3 fe80::ce81:b1c:bd2c:69e
utun4 fe80::9e76:eff:fe46:bb8d
```

Offered (9 records on 5 interfaces), with labels resolved automatically:

```
lo0    127.0.0.1                                IPv4  internal=true   Loopback (this Mac only)
lo0    ::1                                      IPv6  internal=true   Loopback (this Mac only)
en0    10.42.14.189                             IPv4  internal=false  Ethernet
en11   10.42.13.86                              IPv4  internal=false  RTL8156B
en11   fd7b:3b1d:e25e:4632:ca7:a879:c881:aa1    IPv6  internal=false  RTL8156B
en1    10.42.11.104                             IPv4  internal=false  Wi-Fi
en1    fd7b:3b1d:e25e:4632:1475:4570:fc60:25a9  IPv6  internal=false  Wi-Fi
utun4  100.92.197.95                            IPv4  internal=false  unnamed (utun4) - possibly Tailscale
utun4  fd7a:115c:a1e0::9936:c560                IPv6  internal=false  unnamed (utun4) - possibly Tailscale
```

`awdl0`, `llw0` and `utun0`–`utun3` disappear entirely. **29 → 11 → 5, with no name matching.**

### 3.3 Failure modes - what the rule gets wrong

**[FACT] The link-local rule hides the only address AWDL has.** That is intended, but if
someone ever genuinely wanted an AWDL-scoped listener, the rule forbids it. Measured: binding
`fe80::5c60:faff:fe7a:88f0%awdl0` **succeeds**. It is a real, bindable endpoint. We are
choosing not to offer it.

**[FACT] Link-local IPv6 requires the interface *name* as the zone, and `scopeid` will not
substitute.** Measured:

```
FAIL  fe80::8fa:c29a:af2:e60a          EADDRNOTAVAIL   (no zone)
OK    fe80::8fa:c29a:af2:e60a%en0      -> {"address":"fe80::8fa:c29a:af2:e60a%en0",...}
FAIL  fe80::8fa:c29a:af2:e60a%8        EADDRNOTAVAIL   (numeric zone == the scopeid)
FAIL  fe80::8fa:c29a:af2:e60a%99       EADDRNOTAVAIL
```

So `os.networkInterfaces()` hands you a string that is *not* directly bindable, and the
`scopeid` field it hands you alongside is *not* the fix. Anyone who "just uses `.address`"
gets `EADDRNOTAVAIL` on every fe80 entry. This is the single most likely implementation bug.

**[JUDGEMENT] It cannot distinguish "the VPN you want" from "the VPN your employer pushed".**
`utun4` is offered here because it has a global-ish address. A corporate always-on VPN would
look identical and would be offered too. There is no programmatic signal for intent; the label
from `scutil --nc list` is the mitigation, not a fix.

**[FACT] `scutil --nc list` does not map a VPN to its `utun` number.**
`networksetup -listnetworkserviceorder` shows `(10) Tailscale … Device: ` - **empty**. So the
label "possibly Tailscale" is a heuristic join, not a lookup. With two VPNs up, you could not
tell which `utun` is which from these tools. **[UNRESOLVED]** whether a supported API exists
for that mapping; not needed for the recommendation below.

**[JUDGEMENT] Unique-local IPv6 (`fd7b:…` on `en1`/`en11`) is offered but is a poor default.**
It is a valid, non-link-local address, so the rule keeps it - correctly, per the rule's own
logic - but it is LAN-scoped and unfamiliar. Sort IPv4 above IPv6 in the picker.

**[JUDGEMENT] `169.254/16` is *usually* noise, not always.** A directly-cabled ESP32 with no
DHCP server would self-assign into that range on both ends, and that is a plausible bench
setup for this project. Filter it by default; do not make it unreachable.

**[FACT] A hotspot changes the answer.** `ap1` is UP+RUNNING with no address today; enabling
Personal Hotspot gives it one and it becomes a legitimate offer. The rule handles this
correctly with no change, because it never mentions `ap1`.

---

## 4. Binding semantics - the part that bites

### 4.1 Node binds an address. It cannot bind an interface. **[FACT]**

`server.listen(port, host)` takes a `host` string that must resolve to an address already
present on this machine. Node's `listen` options are `port`, `host`, `path`, `backlog`,
`exclusive`, `readableAll`, `writableAll`, `ipv6Only`, `reusePort`, `signal`. **There is no
interface option.** Apple's own advice is explicit that the address is the wrong handle:

> **[FACT]** *"If you're listening for incoming network connections, you don't need to bind to
> a specific address. Rather, listen on all local addresses."* … For a genuine
> interface binding, use *"`IP_BOUND_IF` or `IPV6_BOUND_IF` socket options (bind to interface,
> not address)"* - and *"Don't bind to the interface's IP address directly - it changes."*
> — <https://developer.apple.com/forums/thread/734295>

**`IP_BOUND_IF` is not reachable from Node without a native addon.** So "pick an interface" in
a Node server is, unavoidably, "pick an address" - and Apple is telling us that is the thing
not to persist.

### 4.2 Measured bind behaviour

```
OK    0.0.0.0                            IPv4 wildcard
OK    ::                                 IPv6 wildcard          (dual-stack, see below)
OK    127.0.0.1                          loopback v4
OK    ::1                                loopback v6
OK    10.42.14.189                       en0 real address
OK    100.92.197.95                      utun4 Tailscale address
FAIL  10.42.99.99                        EADDRNOTAVAIL: address not available
FAIL  fe80::8fa:c29a:af2:e60a            EADDRNOTAVAIL (link-local without a zone)
OK    fe80::8fa:c29a:af2:e60a%en0        link-local with a zone
OK    fe80::5c60:faff:fe7a:88f0%awdl0    AWDL, with a zone
```

**[FACT] A stale address is a hard startup failure**, `EADDRNOTAVAIL`, emitted on the server's
`'error'` event. Under the D-13 LaunchDaemon with `KeepAlive`, that is a crash-loop, not a
degraded service.

**[FACT] `::` is dual-stack on macOS under Node** (`ipv6Only` defaults to `false`). A server
bound to `::` was reachable via `127.0.0.1`, `10.42.14.189`, **and** `::1`. Node's docs: *"If
`host` is omitted, the server will accept connections on the unspecified IPv6 address (`::`)
when IPv6 is available"*, and *"listening to `::` may cause the `net.Server` to also listen on
`0.0.0.0`"*. **This is what `src/app.ts` does today** - `server.listen(opts.port, resolve)`
with no host. Today's behaviour is already "all interfaces".

### 4.3 The reachability matrix - the finding that matters most **[FACT]**

```
bound to 0.0.0.0
   via 127.0.0.1     -> REACHABLE
   via 10.42.14.189  -> REACHABLE      (en0)
   via 10.42.11.104  -> REACHABLE      (en1, Wi-Fi)
   via 10.42.13.86   -> REACHABLE      (en11, dock)
   via 100.92.197.95 -> REACHABLE      (utun4, Tailscale)

bound to 127.0.0.1
   via 127.0.0.1     -> REACHABLE
   via 10.42.14.189  -> ECONNREFUSED
   via 10.42.11.104  -> ECONNREFUSED
   via 10.42.13.86   -> ECONNREFUSED
   via 100.92.197.95 -> ECONNREFUSED

bound to 10.42.14.189
   via 127.0.0.1     -> ECONNREFUSED   <-- D-24 local admin is DEAD
   via 10.42.14.189  -> REACHABLE
   via 10.42.11.104  -> ECONNREFUSED
   via 10.42.13.86   -> ECONNREFUSED
   via 100.92.197.95 -> ECONNREFUSED

bound to 100.92.197.95
   via 127.0.0.1     -> ECONNREFUSED
   via 100.92.197.95 -> REACHABLE
```

**Picking "Ethernet" in a naive interface picker silently disables loopback.** D-24's
local-admin path - the token waiver that requires the connection to come from loopback - stops
working entirely, because nothing can connect to loopback any more. An interface picker that
binds a single address is therefore not a network-scoping feature; it is a feature that
*breaks the admin surface* as a side effect. This has to be designed around, not documented
around.

### 4.4 Two servers, one handler, is a real option **[FACT]**

```
two http servers, same port, different addresses: OK
   127.0.0.1      -> HTTP 200
   10.42.14.189   -> HTTP 200
   10.42.11.104   -> ECONNREFUSED
```

Binding `127.0.0.1` and `10.42.14.189` on the *same port* with two `http.Server` objects
sharing one request handler works, and gives exactly "loopback plus one chosen interface,
nothing else". This is the mechanism that makes the recommendation in §4.6 implementable.

### 4.5 A local hijack note **[FACT]**

libuv sets `SO_REUSEADDR` unconditionally in `uv__tcp_bind` - `setsockopt(fd, SOL_SOCKET,
SO_REUSEADDR, &on, ...)` with no guard (<https://github.com/libuv/libuv/blob/v1.x/src/unix/tcp.c>)
- and on BSD the more specific bind wins:

```
bind 0.0.0.0:P, then bind 10.42.14.189:P   -> BOTH BOUND
connect to 10.42.14.189:P -> served by SPECIFIC
connect to 127.0.0.1:P    -> served by WILDCARD
```

So while our service is on `0.0.0.0:8484`, another process can bind `10.42.14.189:8484` and
**take all LAN traffic** for that port without any error on our side. Measured same-user.
**[UNRESOLVED]** whether macOS permits this across UIDs. It does not change the recommendation
- D-24 already declares malware running as this user out of scope - but it is worth knowing
that "I bound the port" is not the same as "I own the port".

### 4.6 What happens when the address changes or disappears

| Event | Stored `0.0.0.0`/`::` | Stored bare address |
|---|---|---|
| DHCP renews, same address | no effect | no effect |
| DHCP hands out a different address | **keeps working**, new address serves immediately | **[FACT]** running socket is bound to an address the host no longer has → unreachable. Restart → `EADDRNOTAVAIL` → LaunchDaemon crash-loop |
| Laptop moves network | **keeps working** | same as above |
| Cable unplugged / Wi-Fi off | loopback and remaining interfaces keep working | interface gone → unreachable, restart fails |
| Dock detached (`en11`) | `en11` silently drops out, others fine | dead |
| VPN reconnects with a new `utun` number | **keeps working** | dead |

**[UNRESOLVED]** Whether the kernel *closes* an already-listening socket when its address is
removed, or merely leaves it bound to an address that no longer receives packets. Testing this
requires root (`ifconfig lo0 alias`/`-alias`) and passwordless sudo is not available on this
machine; the search for a primary source on XNU's behaviour was inconclusive. **It does not
change the recommendation:** either way the service is unreachable, and in the "socket
survives" case the failure is *silent* - no `'error'` event fires - which is the worse of the
two.

### 4.7 Recommendation **[JUDGEMENT]**

**Store a mode, not an address.** Config field `ONAIR_BIND` with three shapes:

| Value | Binds | Meaning |
|---|---|---|
| `all` (**default**) | `::` (dual-stack) | Today's behaviour. Every interface, including any VPN, plus loopback. |
| `loopback` | `127.0.0.1` **and** `::1` | This Mac only. The paranoid setting. |
| `iface:<name>` e.g. `iface:en1` | loopback **plus** the first non-link-local address on `<name>`, two servers one handler (§4.4) | "Only my Wi-Fi", without killing admin. |

Four rules that make it survivable:

1. **Loopback is always bound.** It is never a user choice to remove it. This is a D-24
   consequence, and it makes §4.3's trap unreachable by construction.
2. **Store the interface *name*, not the address.** Resolve name → address at every startup.
   A DHCP change is then invisible; the name is stable across it. Apple says BSD names are not
   API across *devices*, which is true - but they are stable on *this* machine across a reboot,
   and we re-resolve anyway, so the risk is bounded.
3. **Keep the friendly label as a hint, not a key.** Persist
   `{ mode: "iface", ifname: "en1", label: "Wi-Fi", lastAddress: "10.42.11.104" }`. `ifname` is
   what resolves; `label` and `lastAddress` exist only to show the user what they picked and to
   detect drift.
4. **Never fail closed on the chosen interface.** If `<name>` is absent or has no non-link-local
   address at startup: **bind loopback, start anyway, and surface a warning on the admin card.**
   A service that boots with a visible "Wi-Fi not found, listening on loopback only" beats a
   LaunchDaemon crash-loop that Rocket has to `onair` his way out of. Re-attempt the interface
   bind on a timer, or on the next request to the admin route - `os.networkInterfaces()` is
   cheap and live (§1.2), so a 10-second poll that promotes loopback-only to
   loopback+interface when the address appears is trivial and removes the whole failure class.

**Why not just always `0.0.0.0`?** Because Rocket asked for the control, and because "all
interfaces" genuinely includes a VPN that reaches outside the house. But the honest framing for
the UI is that this is a **reduction** switch with a default of "everything", not an interface
*selector* - and `all` should stay the default because it is the only setting that cannot be
invalidated by the network changing underneath it.

---

## Open items for the v2 spec

- **Does the ESP32 poller care?** It polls the server (D-17). If `ONAIR_BIND` is narrowed to an
  interface the device is not on, the light goes stale. The picker UI must say which interface
  the device last polled from - the server already sees `remoteAddress` and can match it
  against each candidate's CIDR to mark one "your light is on this network".
- **Port + address is the identity, and `/ui`'s displayed URL must follow.** D-25 serves `/ui`
  unauthenticated; whatever URL it prints for the ESP32 and for Companion has to be derived
  from the resolved bind, not hard-coded.
- **`reusePort`** (Node 22.12+) is not needed here and should stay off; §4.5 shows enough
  ambient port-sharing already.

## Reproducing this

Commands run: `ifconfig -a`, `networksetup -listallhardwareports`,
`networksetup -listnetworkserviceorder`, `networksetup -getinfo "Wi-Fi"`, `scutil --nc list`,
`netstat -rn -f inet`, `node --version`, `sw_vers`, and four throwaway Node scripts
(enumeration, bind matrix, reachability matrix, heuristic). The scripts were not kept; each
one is short enough that the pasted output is the artifact.

## Sources

- Node.js `os` API - <https://nodejs.org/docs/latest-v24.x/api/os.html>
- Node.js `net` API - <https://nodejs.org/docs/latest-v24.x/api/net.html>
- libuv `src/unix/bsd-ifaddrs.c` - <https://github.com/libuv/libuv/blob/v1.x/src/unix/bsd-ifaddrs.c>
- Node.js `src/node_os.cc` - <https://github.com/nodejs/node/blob/main/src/node_os.cc>
- Apple DTS, "Network Interface Concepts" - <https://developer.apple.com/forums/thread/734293>
- Apple DTS, "Don't Try to Get the Device's IP Address" - <https://developer.apple.com/forums/thread/734295>
- Apple DTS, "Remove Unused Network Links" - <https://developer.apple.com/forums/thread/820120>
- Apple DTS, "Extra-ordinary Networking" index - <https://developer.apple.com/forums/thread/734348>
