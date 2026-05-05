# Distribution channel templates (W7.7)

Drop-in templates for publishing `claudestruct` (`cs`) on the major
package repositories. The version + checksum fields are placeholders;
the release workflow (W4.3, pending) rewrites them on every tag and
pushes to the appropriate hosting repo.

| Channel       | Template                       | Hosting repo (TBD)                          | Status      |
| ------------- | ------------------------------ | ------------------------------------------- | ----------- |
| Homebrew      | `homebrew/claudestruct.rb`     | `tonyandclaw/homebrew-tap`                  | template    |
| Scoop         | `scoop/claudestruct.json`      | `tonyandclaw/scoop-bucket`                  | template    |
| AUR (Arch)    | `aur/PKGBUILD`                 | `aur.archlinux.org/claudestruct.git`        | template    |
| Snap (Ubuntu) | `snap/snapcraft.yaml`          | Snapcraft store (`tonyandclaw` publisher)   | template    |

All four currently ship the **Python `cs` CLI only**. A future
`claudestruct-full` channel will bundle `claw-squad` (Node) and
`claw-sandbox` (Go) once the release workflow produces reproducible
artifacts for the non-Python halves.

## Manual publishing flow (until release automation lands)

### Homebrew (one-time setup, then per-release)

```bash
# One-time: create the tap repo.
gh repo create tonyandclaw/homebrew-tap --public --description "Homebrew tap"

# Per-release: rewrite the placeholders, push.
sed -e "s/VERSION/$VER/g" -e "s/SHA256_PLACEHOLDER/$SHA/" \
  packaging/homebrew/claudestruct.rb > /tmp/claudestruct.rb
# Push to Formula/claudestruct.rb in the tap repo.
```

### Scoop

```bash
gh repo create tonyandclaw/scoop-bucket --public --description "Scoop bucket"
# Per-release: same sed-then-push pattern, target bucket/claudestruct.json.
```

### AUR

```bash
# One-time: register an AUR account, add ssh key.
ssh -T [email protected]

# Per-release:
cd packaging/aur
sed -i "s/^pkgver=.*/pkgver=$VER/" PKGBUILD
updpkgsums                    # rewrites sha256sums
makepkg --printsrcinfo > .SRCINFO
git push aur master
```

### Snap

```bash
snapcraft login
snapcraft pack packaging/snap/      # builds claudestruct_*.snap
snapcraft upload --release=stable claudestruct_*.snap
```

## Linking back into the docs site

`docs/install.md` walks new users through each channel. Keep that
file in sync when a channel goes from "template" to "published".
