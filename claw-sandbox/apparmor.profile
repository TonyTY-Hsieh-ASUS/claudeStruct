#include <tunables/global>

# AppArmor profile for claw-sandbox. Apply with:
#   sudo apparmor_parser -r -W claw-sandbox/apparmor.profile
#   docker run --security-opt apparmor=claw-sandbox ...
#
# The profile assumes the sandbox runs from `/usr/local/bin/claw-sandbox`
# inside the container; adjust the path below for other layouts. Pair
# this with seccomp.json — seccomp filters syscalls, AppArmor filters
# what those syscalls can touch on the filesystem.
#
# Threat model: an LLM-generated Coder running inside should be able to
# read project files + write into the working tree + invoke standard
# build / test runners, but NOT escape into / read host secrets / load
# kernel surfaces. This profile is permissive enough that pytest /
# vitest / go test work, restrictive enough that /etc/shadow, host
# kernel-tracing facilities, and arbitrary /proc writes do not.

profile claw-sandbox flags=(attach_disconnected, mediate_deleted) {
  #include <abstractions/base>
  #include <abstractions/nameservice>

  # The sandbox binary itself.
  /usr/local/bin/claw-sandbox       mr,
  /usr/bin/claw-sandbox             mr,

  # Standard interpreters / build tools the Coder may legitimately invoke.
  /usr/bin/{python*,node,npm,pnpm,go,gofmt,bash,sh,git,make,gcc,clang} ix,
  /usr/local/bin/{python*,node,npm,pnpm,go} ix,

  # Read access to standard libs / system headers — needed by every
  # toolchain on the planet.
  /usr/lib/**                       r,
  /usr/include/**                   r,
  /lib/**                           r,
  /lib64/**                         r,
  /etc/ld.so.cache                  r,
  /etc/ld.so.conf                   r,
  /etc/ld.so.conf.d/**              r,

  # The repo working tree (assumed under /workspace inside the container).
  /workspace/**                     rw,
  /workspace/                       r,

  # Temp scratch. Most build systems write here.
  owner /tmp/**                     rwk,
  owner /var/tmp/**                 rwk,

  # Network resolver config (read-only). Without this, dns lookups fail
  # silently inside the container — confusing for users debugging "why
  # does pip install hang".
  /etc/resolv.conf                  r,
  /etc/nsswitch.conf                r,
  /etc/hosts                        r,
  /etc/host.conf                    r,
  /etc/services                     r,

  # /proc — very narrow. Process self-introspection works (toolchains
  # rely on /proc/self/exe), broad scanning of other PIDs is denied.
  owner /proc/self/**               r,
  owner /proc/[0-9]*/fd/[0-9]*      r,
  /proc/cpuinfo                     r,
  /proc/meminfo                     r,
  /proc/uptime                      r,
  /proc/stat                        r,
  /proc/version                     r,
  deny /proc/sys/kernel/**          rw,
  deny /proc/kallsyms               r,
  deny /proc/kcore                  r,

  # Block direct host secrets even if a misconfigured mount exposes them.
  deny /etc/shadow                  r,
  deny /etc/gshadow                 r,
  deny /etc/sudoers                 r,
  deny /etc/sudoers.d/**            r,
  deny /root/**                     rw,
  deny /home/[^/]+/.ssh/**          rw,
  deny /home/[^/]+/.aws/credentials rw,
  deny /home/[^/]+/.config/gh/**    rw,

  # Block kernel-tracing + control interfaces. The seccomp profile
  # already errors out the relevant syscalls; this is defense in depth.
  deny /sys/kernel/debug/**         rw,
  deny /sys/kernel/tracing/**       rw,
  deny /dev/mem                     rw,
  deny /dev/kmem                    rw,
  deny /dev/port                    rw,

  # Capabilities the sandbox legitimately uses (rlimit + own-process).
  capability setpcap,
  capability sys_resource,

  # Everything else not explicitly granted is implicitly denied because
  # AppArmor profiles are deny-by-default once they're loaded.
}
