// Keep this signed native process alive as the responsible app for the Node helper.
import Foundation
import Darwin
import Network

private var childPID: pid_t = 0
private var pendingSignal: Int32 = 0
private func forwardSignal(_ number: Int32) {
    if childPID > 0 { _ = Darwin.kill(-childPID, number) }
    else { pendingSignal = number }
}

private func fail(_ message: String, _ code: Int32 = 125) -> Never {
    FileHandle.standardError.write(Data(("On Air Receiver: " + message + "\n").utf8))
    exit(code)
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
var attr: posix_spawnattr_t? = nil
if posix_spawnattr_init(&attr) != 0 { fail("could not initialize child attributes") }
defer { posix_spawnattr_destroy(&attr) }
var emptyMask = sigset_t()
sigemptyset(&emptyMask)
var defaults = sigset_t()
sigemptyset(&defaults)
for number in [SIGTERM, SIGINT, SIGHUP] { sigaddset(&defaults, number) }
posix_spawnattr_setsigmask(&attr, &emptyMask)
posix_spawnattr_setsigdefault(&attr, &defaults)
posix_spawnattr_setpgroup(&attr, 0)
posix_spawnattr_setflags(&attr, Int16(POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF | POSIX_SPAWN_SETPGROUP))
let argv = ([runtime] + arguments).map { strdup($0) } + [nil]
defer { argv.forEach { free($0) } }
var pid: pid_t = 0
let result = argv.withUnsafeBufferPointer { buffer in
    posix_spawn(&pid, runtime, nil, &attr, UnsafeMutablePointer(mutating: buffer.baseAddress!), environ)
}
if result != 0 { fail("could not start bundled Node: \(String(cString: strerror(result)))", 126) }
childPID = pid
if pendingSignal != 0 { _ = Darwin.kill(-pid, pendingSignal) }
var status: Int32 = 0
while waitpid(pid, &status, 0) < 0 {
    if errno != EINTR { fail("could not wait for bundled Node") }
}
childPID = 0
let signalNumber = status & 0x7f
exit(signalNumber == 0 ? (status >> 8) & 0xff : 128 + signalNumber)
