#!/usr/bin/env bash
# Read-only checks before provisioning CRC (OKD preset) on this machine.
set -uo pipefail
ok=1; chk(){ if eval "$2"; then echo "  ok   $1"; else echo "  FAIL $1"; ok=0; fi; }
echo "== hardware"
chk "CPU virtualization flag (vmx/svm) - enable VT-x/AMD-V in BIOS if missing" "grep -Eq '(vmx|svm)' /proc/cpuinfo"
chk "/dev/kvm present" "[[ -e /dev/kvm ]]"
chk ">= 16 GB RAM available (now: $(free -g | awk '/Mem:/{print $7}') GB)" "(( $(free -g | awk '/Mem:/{print $7}') >= 16 ))"
chk ">= 35 GB free disk in \$HOME (now: $(df -BG --output=avail "$HOME" | tail -1 | tr -dc 0-9) GB)" "(( $(df -BG --output=avail "$HOME" | tail -1 | tr -dc 0-9) >= 35 ))"
echo "== tools (infra/okd/scripts/install-tools.sh installs oc + crc into ~/bin)"
for t in oc crc openssl docker psql; do chk "$t" "command -v $t >/dev/null"; done
echo "== libvirt"
chk "user in libvirt group" "id -nG | grep -qw libvirt"
echo "== crc"
if command -v crc >/dev/null; then
  echo "  preset: $(crc config get preset 2>&1)  (need: okd)"
  echo "  status: $(crc status 2>&1 | head -2 | tr '\n' ' ')"
  ip addr show crc 2>/dev/null | awk '/inet /{print "  host bridge IP (PG_HOST_IP): " $2}'
fi
(( ok )) && echo "READY" || { echo "NOT READY"; exit 1; }
