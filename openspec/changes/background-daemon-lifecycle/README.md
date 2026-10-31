# background-daemon-lifecycle

Run the zed-herdr synchronization daemon as a detached background process: plugin hooks start exactly one hidden daemon without opening a HerdR pane, an explicit start command is idempotent, stop performs owner-validated graceful shutdown, and health reports background daemons that own no pane.
