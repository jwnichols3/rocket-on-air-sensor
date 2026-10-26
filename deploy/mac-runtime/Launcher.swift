// Keep this signed native process alive as the responsible app for the Node helper.
import Foundation
import Darwin
import Network

private var childPID: pid_t = 0
private var pendingSignal: Int32 = 0
private var shutdownStarted: Int32 = 0
private var forcedShutdown: Int32 = 0
private func forceShutdown(_ number: Int32) {
    let savedErrno = errno
    forcedShutdown = 1
    if childPID > 0 { _ = Darwin.kill(childPID, SIGKILL) }
    errno = savedErrno
}
private func forwardSignal(_ number: Int32) {
    let savedErrno = errno
    pendingSignal = number
    if shutdownStarted == 0 {
        shutdownStarted = 1
        _ = Darwin.alarm(3)
    }
    if childPID > 0 { _ = Darwin.kill(childPID, number) }
    errno = savedErrno
}

private func fail(_ message: String, _ code: Int32 = 125) -> Never {
    FileHandle.standardError.write(Data(("On Air Receiver: " + message + "\n").utf8))
    exit(code)
}

// launchd's group cleanup can leave a TERM-ignoring grandchild alive. This small
// guardian waits in the kernel for the supervisor to exit, then kills that owned
// job group. It is ready before Node starts, ignores soft shutdown signals, and
// also works when the supervisor receives SIGKILL and cannot run a handler.
if CommandLine.arguments.count == 6 && CommandLine.arguments[1] == "--watch-parent",
   let parent = Int32(CommandLine.arguments[2]), let group = Int32(CommandLine.arguments[3]),
   let readFD = Int32(CommandLine.arguments[4]), let readyFD = Int32(CommandLine.arguments[5]) {
    guard parent > 1, group == parent, getpgrp() == group, getpid() != group,
          getppid() == parent, readFD >= 3, readyFD >= 3 else { exit(125) }
    close(readFD)
    for number in [SIGTERM, SIGINT, SIGHUP] { _ = Darwin.signal(number, SIG_IGN) }
    let queue = kqueue()
    guard queue >= 0 else { exit(125) }
    var event = kevent(ident: UInt(parent), filter: Int16(EVFILT_PROC),
                       flags: UInt16(EV_ADD | EV_ONESHOT), fflags: UInt32(NOTE_EXIT),
                       data: 0, udata: nil)
    guard kevent(queue, &event, 1, nil, 0, nil) == 0 else { exit(125) }
    var ready: UInt8 = 1
    guard Darwin.write(readyFD, &ready, 1) == 1 else { exit(125) }
    close(readyFD)
    while kevent(queue, nil, 0, &event, 1, nil) < 0 {
        if errno != EINTR { exit(125) }
    }
    _ = Darwin.kill(-group, SIGKILL)
    exit(0)
}

let executable = URL(fileURLWithPath: CommandLine.arguments[0]).resolvingSymlinksInPath()
let contents = executable.deletingLastPathComponent().deletingLastPathComponent()
let runtime = contents.appendingPathComponent("Helpers/node").path
var arguments = Array(CommandLine.arguments.dropFirst())
private func printLauncherInfo() {
    let bundle = Bundle.main
    let info: [String: Any] = [
        "phase": "launcher",
        "bundleIdentifier": bundle.bundleIdentifier ?? "unknown",
        "displayName": bundle.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String ?? "unknown",
        "bundlePath": bundle.bundlePath,
        "executablePath": executable.path,
        "runtimePath": runtime,
        "pid": getpid(),
        "parentPid": getppid(),
    ]
    if var data = try? JSONSerialization.data(withJSONObject: info, options: [.sortedKeys]) {
        data.append(0x0a)
        FileHandle.standardOutput.write(data)
    }
}
if arguments == ["--launcher-info"] {
    printLauncherInfo()
    exit(0)
}
if arguments.first == "--probe" {
    printLauncherInfo()
    guard arguments.count == 2, let url = URL(string: arguments[1]),
          url.scheme == "http" || url.scheme == "https", let host = url.host,
          url.user == nil, url.password == nil else { fail("usage: --probe http[s]://host/path") }
    let portNumber = url.port ?? (url.scheme == "https" ? 443 : 80)
    guard let portValue = UInt16(exactly: portNumber), portValue > 0,
          let port = NWEndpoint.Port(rawValue: portValue) else {
        fail("invalid probe port")
    }
    // Network.framework can present the normal consent prompt when BSD socket calls do
    // not. It opens no proxy: the subsequent GET still runs in the real Node helper.
    let ready = DispatchSemaphore(value: 0)
    let connection = NWConnection(host: NWEndpoint.Host(host), port: port, using: .tcp)
    connection.stateUpdateHandler = { state in
        switch state {
        case .ready, .failed, .cancelled: ready.signal()
        default: break
        }
    }
    connection.start(queue: DispatchQueue(label: "onair.network-consent"))
    _ = ready.wait(timeout: .now() + 30)
    connection.cancel()
    arguments = [contents.appendingPathComponent("Resources/probe.mjs").path, arguments[1]]
}

guard FileManager.default.isExecutableFile(atPath: runtime) else { fail("bundled Node is missing") }
for number in [SIGTERM, SIGINT, SIGHUP] { _ = Darwin.signal(number, forwardSignal) }
_ = Darwin.signal(SIGALRM, forceShutdown)
var attr: posix_spawnattr_t? = nil
if posix_spawnattr_init(&attr) != 0 { fail("could not initialize child attributes") }
defer { posix_spawnattr_destroy(&attr) }
var emptyMask = sigset_t()
sigemptyset(&emptyMask)
var defaults = sigset_t()
sigemptyset(&defaults)
for number in [SIGTERM, SIGINT, SIGHUP, SIGALRM] { sigaddset(&defaults, number) }
posix_spawnattr_setsigmask(&attr, &emptyMask)
posix_spawnattr_setsigdefault(&attr, &defaults)
// Inherit launchd's job process group. Its default AbandonProcessGroup=false cleanup
// then covers Node and descendants even when kickstart -k kills this supervisor.
// Never signal the whole group here: standalone callers may share their own group.
posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF))
if getpgrp() == getpid() {
    // Only an owned group gets a guardian. A standalone caller's group is never
    // signalled; direct-child TERM/timeout handling below remains available there.
    var pipeFDs: [Int32] = [0, 0]
    guard pipe(&pipeFDs) == 0 else { fail("could not create guardian readiness pipe") }
    let watcherArgs = [executable.path, "--watch-parent", String(getpid()), String(getpgrp()),
                       String(pipeFDs[0]), String(pipeFDs[1])].map { strdup($0) } + [nil]
    var watcher: pid_t = 0
    let watcherResult = watcherArgs.withUnsafeBufferPointer { buffer in
        posix_spawn(&watcher, executable.path, nil, &attr, UnsafeMutablePointer(mutating: buffer.baseAddress!), environ)
    }
    watcherArgs.forEach { free($0) }
    close(pipeFDs[1])
    guard watcherResult == 0 else { close(pipeFDs[0]); fail("could not start shutdown guardian") }
    var descriptor = pollfd(fd: pipeFDs[0], events: Int16(POLLIN), revents: 0)
    var ready: UInt8 = 0
    let becameReady = poll(&descriptor, 1, 2000) > 0 && Darwin.read(pipeFDs[0], &ready, 1) == 1 && ready == 1
    close(pipeFDs[0])
    if !becameReady { _ = Darwin.kill(watcher, SIGKILL); fail("shutdown guardian did not become ready") }
}
let argv = ([runtime] + arguments).map { strdup($0) } + [nil]
defer { argv.forEach { free($0) } }
var pid: pid_t = 0
let result = argv.withUnsafeBufferPointer { buffer in
    posix_spawn(&pid, runtime, nil, &attr, UnsafeMutablePointer(mutating: buffer.baseAddress!), environ)
}
if result != 0 { fail("could not start bundled Node: \(String(cString: strerror(result)))", 126) }
childPID = pid
if forcedShutdown != 0 { _ = Darwin.kill(pid, SIGKILL) }
else if pendingSignal != 0 { _ = Darwin.kill(pid, pendingSignal) }
var status: Int32 = 0
while waitpid(pid, &status, 0) < 0 {
    if errno != EINTR { fail("could not wait for bundled Node") }
}
childPID = 0
_ = Darwin.alarm(0)
if forcedShutdown != 0 {
    FileHandle.standardError.write(Data("On Air Receiver: Node exceeded the 3-second shutdown grace; terminated and reaped.\n".utf8))
}
let signalNumber = status & 0x7f
exit(signalNumber == 0 ? (status >> 8) & 0xff : 128 + signalNumber)
