# The formula published to github.com/bjoernaagaard/homebrew-shrok. The release workflow fills in the
# version, the archive URLs and their sha256 from the macOS archives it builds.
class Shrok < Formula
  desc "Personal assistant you talk to through SimpleX"
  homepage "https://github.com/bjoernaagaard/shrok"
  version "@VERSION@"
  license "AGPL-3.0-only"

  on_arm do
    url "https://github.com/bjoernaagaard/shrok/releases/download/v@VERSION@/shrok-@VERSION@-macos-arm64.tar.gz"
    sha256 "@SHA256_ARM64@"
  end

  on_intel do
    url "https://github.com/bjoernaagaard/shrok/releases/download/v@VERSION@/shrok-@VERSION@-macos-x64.tar.gz"
    sha256 "@SHA256_X64@"
  end

  depends_on :macos
  depends_on "ripgrep"

  # Homebrew rewrites the ID of every dylib in the Cellar, which the bundled browser has no room for, and
  # which would break the signatures of the bundled binaries. So the app stays packed in the Cellar and the
  # post-install steps unpack it into var, where Homebrew leaves files as they are.
  def install
    system "tar", "-czf", "shrok.tar.gz", *Dir["*"]
    libexec.install "shrok.tar.gz"
    (bin/"shrok").write_env_script app/"bin/shrok", {}
  end

  post_install_steps do
    remove "shrok/app", base: :var, recursive: true
    mkdir_p "shrok/app", base: :var
    run "/usr/bin/tar",
        args: ["-xzf", "{{HOMEBREW_PREFIX}}/opt/shrok/libexec/shrok.tar.gz", "-C", "{{HOMEBREW_PREFIX}}/var/shrok/app"]
  end

  def app
    var/"shrok/app"
  end

  def caveats
    <<~EOS
      Put your model key in a file only you can read:
        mkdir -p ~/Library/Application\ Support/Shrok
        (umask 077; echo 'ANTHROPIC_API_KEY=sk-ant-...' >> ~/Library/Application\ Support/Shrok/secrets.env)
      Add SHROK_TIME_ZONE and other settings there too, one NAME=value per line.
      Then start Shrok and pair your phone:
        brew services start shrok
        shrok pair
      Shrok keeps its data in ~/Library/Application Support/Shrok.
    EOS
  end

  service do
    run [opt_bin/"shrok", "run"]
    keep_alive successful_exit: false
    # So the service finds gws and xurl when they are installed with Homebrew or npm.
    environment_variables PATH: std_service_path_env
    log_path var/"log/shrok.log"
    error_log_path var/"log/shrok.log"
  end

  test do
    assert_match "Usage:", shell_output("#{bin}/shrok help 2>&1", 2)
  end
end
