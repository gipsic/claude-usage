# Homebrew formula for claude-usage.
#
# Lives in the tap gipsic/homebrew-tap; this copy is the source of truth and is
# what bin/release-homebrew.sh copies over on release.
#
#   brew tap gipsic/tap
#   brew install claude-usage
#
# It installs from the GitHub release tarball rather than npm: the package has no
# dependencies, so there is nothing for npm to resolve, and the sh launcher in
# the tarball is the one that finds node under nvm/fnm/volta when launchd starts
# the agent with a bare PATH.
class ClaudeUsage < Formula
  desc "Local usage, limit and cost dashboard for Claude Code"
  homepage "https://github.com/gipsic/claude-usage"
  url "https://github.com/gipsic/claude-usage/archive/refs/tags/v1.5.3.tar.gz"
  sha256 "40893eee6b53cc817a0ba29d0e3296a0378a507553f98e4e612356c0a99404a0"
  license "MIT"

  depends_on "node"

  def install
    libexec.install Dir["*"]
    # The launcher resolves symlinks to find its own root, so a symlink into
    # bin is enough - and it keeps `claude-usage install-daemon` pointing at a
    # path that survives upgrades.
    bin.install_symlink libexec/"claude-usage"
  end

  def caveats
    <<~EOS
      Start the background tracker (a launchd agent that runs at login):
        claude-usage install-daemon

      Then open the dashboard:
        claude-usage serve --open      # http://127.0.0.1:4778

      Percentages come from your own Claude Code login. The first read may ask
      whether node may access "Claude Code-credentials" - choose Always Allow.
      Nothing leaves the machine except the usage request to api.anthropic.com.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/claude-usage --version")
    # doctor must run without a config, a database or a login.
    output = shell_output("CLAUDE_USAGE_HOME=#{testpath}/data CLAUDE_USAGE_NO_KEYCHAIN=1 #{bin}/claude-usage doctor")
    assert_match "claude-usage doctor", output
  end
end
