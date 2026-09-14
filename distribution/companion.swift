import Cocoa
import ScreenCaptureKit
import ApplicationServices

let fm = FileManager.default
let support = fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/Grokish Studio Companion")
func config() -> [String:Any] { (try? JSONSerialization.jsonObject(with: Data(contentsOf:support.appendingPathComponent("config.json")))) as? [String:Any] ?? [:] }
func stateRoot() -> URL { URL(fileURLWithPath: config()["hermesHome"] as? String ?? fm.homeDirectoryForCurrentUser.appendingPathComponent(".hermes").path).appendingPathComponent("studio-cloud") }
func output(_ value:[String:Any]) { if let data=try? JSONSerialization.data(withJSONObject:value,options:[.sortedKeys]) { FileHandle.standardOutput.write(data);FileHandle.standardOutput.write(Data([10])) } }
func desktopAllowed() -> Bool {
    if fm.fileExists(atPath:stateRoot().appendingPathComponent("access-paused").path) {return false}
    guard let data=try? Data(contentsOf:stateRoot().appendingPathComponent("desktop-access.json")),let value=(try? JSONSerialization.jsonObject(with:data)) as? [String:Any],let expires=value["expires"] as? Double else {return false}
    return expires>Date().timeIntervalSince1970 && value["stopped"] as? Bool != true
}

@MainActor final class Companion: NSObject, NSApplicationDelegate {
    var item:NSStatusItem!
    var titleItem=NSMenuItem(title:"Revenue Partner Studio",action:nil,keyEquivalent:"")
    func applicationDidFinishLaunching(_ notification:Notification) {
        item=NSStatusBar.system.statusItem(withLength:NSStatusItem.variableLength)
        item.button?.title="✳"
        let menu=NSMenu();menu.addItem(titleItem);menu.addItem(NSMenuItem.separator())
        for (title,selector) in [("Open Studio",#selector(openStudio)),("Stop Studio access",#selector(stopAccess)),("Resume Studio connection",#selector(resumeAccess)),("Enable desktop permissions…",#selector(permissions)),("Quit companion menu",#selector(quit))] {
            let row=NSMenuItem(title:title,action:selector,keyEquivalent:"");row.target=self;menu.addItem(row)
        }
        item.menu=menu
        Timer.scheduledTimer(withTimeInterval:3,repeats:true){[weak self] _ in Task{@MainActor in self?.update()}}
        update()
    }
    func update() {
        let paused=fm.fileExists(atPath:stateRoot().appendingPathComponent("access-paused").path)
        titleItem.title=paused ? "Studio access stopped" : desktopAllowed() ? "Studio desktop access active" : "Studio companion running"
        item.button?.title=paused ? "✳ ⏸" : desktopAllowed() ? "✳ ●" : "✳"
    }
    @objc func openStudio(){if let address=config()["cloudUrl"] as? String,let url=URL(string:address){NSWorkspace.shared.open(url)}}
    @objc func stopAccess(){try? Data("Stopped from the Mac".utf8).write(to:stateRoot().appendingPathComponent("access-paused"),options:.atomic);try? Data("{}".utf8).write(to:stateRoot().appendingPathComponent("desktop-access.json"),options:.atomic);update()}
    @objc func resumeAccess(){try? fm.removeItem(at:stateRoot().appendingPathComponent("access-paused"));update()}
    @objc func permissions(){
        _=CGRequestScreenCaptureAccess()
        _=AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String:true] as CFDictionary)
    }
    @objc func quit(){NSApp.terminate(nil)}
}

let args=CommandLine.arguments
if args.contains("--permissions") {
    output(["screenRecording":CGPreflightScreenCaptureAccess(),"accessibility":AXIsProcessTrusted()])
} else if let index=args.firstIndex(of:"--capture"),index+1<args.count {
    guard desktopAllowed() else {output(["error":"Approve this desktop session in Studio first."]);exit(2)}
    guard CGPreflightScreenCaptureAccess() else {output(["error":"Screen Recording permission is needed for the Studio companion on this Mac."]);exit(3)}
    if #available(macOS 14.0,*) {
        Task {
            do {
                let content=try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:true)
                guard let display=content.displays.first else {throw NSError(domain:"Studio",code:1)}
                let filter=SCContentFilter(display:display,excludingWindows:[])
                let configuration=SCStreamConfiguration();configuration.width=min(display.width,1920);configuration.height=Int(Double(display.height)*Double(configuration.width)/Double(display.width));configuration.showsCursor=true
                let image=try await SCScreenshotManager.captureImage(contentFilter:filter,configuration:configuration)
                let bitmap=NSBitmapImageRep(cgImage:image)
                guard let data=bitmap.representation(using:.jpeg,properties:[.compressionFactor:0.7]) else {throw NSError(domain:"Studio",code:2)}
                try data.write(to:URL(fileURLWithPath:args[index+1]),options:.atomic)
                output(["width":configuration.width,"height":configuration.height]);exit(0)
            }catch{output(["error":"Mac desktop capture is unavailable. Check its permissions and unlocked desktop session."]);exit(4)}
        }
        RunLoop.main.run()
    }else{output(["error":"Live Mac desktop viewing requires macOS 14 or newer."]);exit(5)}
} else if let index=args.firstIndex(of:"--input"),index+1<args.count {
    guard desktopAllowed(),AXIsProcessTrusted(),let bytes=Data(base64Encoded:args[index+1]),let value=(try? JSONSerialization.jsonObject(with:bytes)) as? [String:Any] else {output(["error":"Desktop access or Accessibility permission is unavailable."]);exit(2)}
    guard let accessData=try? Data(contentsOf:stateRoot().appendingPathComponent("desktop-access.json")),let access=(try? JSONSerialization.jsonObject(with:accessData)) as? [String:Any],access["paused"] as? Bool == true else {output(["error":"Take control before sending desktop input."]);exit(2)}
    let source=CGEventSource(stateID:.combinedSessionState)
    switch value["type"] as? String {
    case "click":
        let bounds=CGDisplayBounds(CGMainDisplayID()),x=max(0,min(1,value["x"] as? Double ?? 0)),y=max(0,min(1,value["y"] as? Double ?? 0))
        let point=CGPoint(x:bounds.origin.x+x*bounds.width,y:bounds.origin.y+y*bounds.height)
        let right=value["button"] as? String == "right"
        CGEvent(mouseEventSource:source,mouseType:right ? .rightMouseDown:.leftMouseDown,mouseCursorPosition:point,mouseButton:right ? .right:.left)?.post(tap:.cghidEventTap)
        CGEvent(mouseEventSource:source,mouseType:right ? .rightMouseUp:.leftMouseUp,mouseCursorPosition:point,mouseButton:right ? .right:.left)?.post(tap:.cghidEventTap)
    case "text":
        let text=String((value["text"] as? String ?? "").prefix(10000));let chars=Array(text.utf16)
        for down in [true,false]{let event=CGEvent(keyboardEventSource:source,virtualKey:0,keyDown:down);event?.keyboardSetUnicodeString(stringLength:chars.count,unicodeString:chars);event?.post(tap:.cghidEventTap)}
    case "key":
        let keys:[String:CGKeyCode]=["Enter":36,"Escape":53,"Backspace":51,"Delete":117,"Tab":48,"ArrowLeft":123,"ArrowRight":124,"ArrowDown":125,"ArrowUp":126,"Home":115,"End":119,"PageUp":116,"PageDown":121,"a":0,"c":8,"v":9,"x":7,"z":6,"s":1,"f":3,"l":37,"w":13,"t":17,"r":15]
        if let code=keys[value["key"] as? String ?? ""] {
            var flags:CGEventFlags=[]
            if value["meta"] as? Bool == true {flags.insert(.maskCommand)}
            if value["ctrl"] as? Bool == true {flags.insert(.maskControl)}
            if value["alt"] as? Bool == true {flags.insert(.maskAlternate)}
            if value["shift"] as? Bool == true {flags.insert(.maskShift)}
            for down in [true,false]{let event=CGEvent(keyboardEventSource:source,virtualKey:code,keyDown:down);event?.flags=flags;event?.post(tap:.cghidEventTap)}
        }
    case "scroll":
        let delta=Int32(max(-1000,min(1000,value["delta"] as? Double ?? 0)))
        CGEvent(scrollWheelEvent2Source:source,units:.pixel,wheelCount:1,wheel1:delta,wheel2:0,wheel3:0)?.post(tap:.cghidEventTap)
    default:output(["error":"Unsupported desktop input."]);exit(2)
    }
    output(["ok":true])
} else {
    MainActor.assumeIsolated {
    let app=NSApplication.shared;app.setActivationPolicy(.accessory)
    let delegate=Companion();app.delegate=delegate;app.run()
    }
}
