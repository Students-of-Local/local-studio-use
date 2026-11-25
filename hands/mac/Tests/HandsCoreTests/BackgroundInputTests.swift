import CryptoKit
import Carbon.HIToolbox
import ImageIO
import XCTest
@testable import HandsCore

/// Background keys and pointer events: what is refused before a post, and how the readings after one are judged (review of
/// #89).
final class BackgroundInputTests: XCTestCase {
    private func refused(_ spec: String) -> Bool {
        if case .failure = KeyParse.sequence(spec) { return true }
        return false
    }

    /// The key equivalents the menu bar's policy refuses, sent as keys (first-F1).
    func testKeysTheMenuPolicyRefusesAreRefused() {
        for key in ["cmd+q", "cmd+shift+q", "ctrl+cmd+q", "cmd+h", "cmd+opt+h", "cmd+o", "cmd+e", "cmd+m", "cmd+p", "cmd+shift+p",
                    "ctrl+cmd+f", "ctrl+cmd+space", "cmd+?", "cmd+shift+\\", "Tab cmd+q",
                    "fn+f", "fn+e", "fn+ctrl+f", "fn+ctrl+left", "fn+cmd+a"] {
            XCTAssertTrue(refused(key), key)
        }
        for key in ["cmd+a", "cmd+f", "cmd+s", "cmd+z", "cmd+shift+z", "cmd+shift+o", "q", "shift+q", "ctrl+e", "?", "cmd+/", "space", "Return", "fn+left", "fn+f5", "ctrl+left"] {
            XCTAssertFalse(refused(key), key)
        }
    }

    /// On another layout the app reads the character, not the key's ANSI place: cmd+' is cmd+q on Dvorak.
    func testALayoutsOwnCharacterIsRefusedToo() {
        guard case .success(let c) = KeyParse.chord("cmd+'") else { return XCTFail("cmd+' parses") }
        XCTAssertNil(KeyParse.refusal(c))
        XCTAssertNotNil(KeyParse.refusal(c, characters: ["q"]))
    }

    /// Typing grows a field and scrolls its view: the same element, compared by its value (first-F2).
    func testTheSameElementAtANewFrameIsComparedByItsValue() {
        let id = ElementReading.identity(role: "AXTextArea", element: 41)
        XCTAssertEqual(id, ElementReading.identity(role: "AXTextArea", element: 41))
        XCTAssertNotEqual(id, ElementReading.identity(role: "AXTextArea", element: 42))
        let before = ElementReading.text(window: 7, identity: id, value: "a"), after = ElementReading.text(window: 7, identity: id, value: "a\n")
        XCTAssertEqual(DeliveryProof.change((before, after), target: 7), [.text])
    }

    /// No refusal names a fixed pixel scale: a shot is fitted to its longest side (first-F3).
    func testPointRefusalsPointAtTheShotsOwnMapping() {
        for e in [BackgroundRefusal.pointOutside(window: 7), BackgroundRefusal.pointInTitleBar(window: 7)] {
            XCTAssertFalse("\(e)".contains("twice"), "\(e)")
            XCTAssertTrue("\(e)".contains("pixels map"), "\(e)")
        }
    }

    /// Only input that can bring an app forward is the person bringing it forward (second-S1).
    func testAMoveOrPlainTypingDoesNotExplainAnActivation() {
        let came = FrontChange.targetCameForward
        let move = SessionEvent(sourcePid: 0, canActivate: false), press = SessionEvent(sourcePid: 0, canActivate: true)
        XCTAssertEqual(PostGuard.verdict(came, events: [move, press]), .userActivated)
        XCTAssertEqual(PostGuard.verdict(came, events: [move]), .unattributed)
        XCTAssertEqual(PostGuard.verdict(came, events: []), .selfActivated)
        XCTAssertEqual(PostGuard.verdict(came, events: [SessionEvent(sourcePid: 42, canActivate: true)]), .selfActivated)
        XCTAssertEqual(PostGuard.verdict(came, events: nil), .unattributed)
        XCTAssertEqual(PostGuard.verdict(.same, events: [press]), .same)
    }

    /// The item pressed is the one that was judged, never a look-alike that took its place (sol-F1).
    func testAContextItemThatBecameAnotherIsNotPressed() {
        func menu(_ name: String, states: [JSONValue] = []) -> JSONValue {
            .object(["role": "menu", "children": .array([.object(["role": "menuitem", "name": .string(name), "ref_id": "@e1", "states": .array(states)])])])
        }
        XCTAssertEqual(ContextMenu.ref(menu("Rename"), title: "Rename"), "@e1")
        XCTAssertEqual(ContextMenu.ref(menu("Rename "), title: "Rename"), "@e1")
        XCTAssertNil(ContextMenu.ref(menu("Rename\u{2026}"), title: "Rename"))
        XCTAssertNil(ContextMenu.ref(menu("Rename..."), title: "Rename"))
        XCTAssertNil(ContextMenu.ref(menu("Rename", states: ["disabled"]), title: "Rename"))
        // Two of one title: neither is judged, and neither is pressed when the second appears later (r2 sol-F3).
        let two = JSONValue.object(["role": "menu", "children": .array([menu("Rename"), menu("Rename")].flatMap { $0["children"]?.array ?? [] })])
        XCTAssertNil(ContextMenu.ref(two, title: "Rename"))
        func chosen(_ titles: [String]) -> Int? {
            try? ContextMenu.choose(titles.map { MenuPath.MenuItem(title: $0) }, enabled: titles.map { _ in true }, want: "Rename").get()
        }
        XCTAssertNil(chosen(["Rename", "Rename"]))
        XCTAssertEqual(chosen(["Open", "Rename", "Rename\u{2026}"]), 1)
    }

    private func layout(_ id: String) throws -> Data {
        let filter = [kTISPropertyInputSourceID as String: "com.apple.keylayout.\(id)"] as CFDictionary
        let found = TISCreateInputSourceList(filter, true)?.takeRetainedValue() as? [TISInputSource]
        let raw = try XCTUnwrap(TISGetInputSourceProperty(XCTUnwrap(found?.first), kTISPropertyUnicodeKeyLayoutData), id)
        return Unmanaged<CFData>.fromOpaque(raw).takeUnretainedValue() as Data
    }

    /// A chord is judged by what its whole chord types, and not sent where the layout has another character on its key
    /// (r2 sol-first-F1, second-S2): on a French keyboard ? is shift with the US m key, and the US z and a keys are w and q.
    func testTheWholeChordIsReadInTheLayout() throws {
        func refusal(_ spec: String, _ id: String) throws -> HandsError? {
            let c = try KeyParse.chord(spec).get(), data = try layout(id)
            return KeyParse.refusal(c, characters: KeyTranslation.characters(c.keyCode, flags: c.flags, layouts: [data], keyboardType: 44))
        }
        XCTAssertTrue(KeyTranslation.characters(46, flags: KeyChord.command | KeyChord.shift, layouts: [try layout("French")], keyboardType: 44).contains("?"))
        for key in ["cmd+shift+m", "cmd+z", "cmd+a", "a", "!"] { XCTAssertNotNil(try refusal(key, "French"), key) }
        XCTAssertNotNil(try refusal("cmd+z", "German"))
        for key in ["cmd+s", "e", "cmd+shift+s"] { XCTAssertNil(try refusal(key, "French"), key) }
        for key in ["cmd+z", "cmd+shift+z", "A", "!", "cmd+/", "ctrl+a", "opt+e"] { XCTAssertNil(try refusal(key, "US"), key) }
    }

    private func judge(_ spec: String, _ before: ElementReading, _ after: ElementReading, content: Bool? = false) throws -> DeliveryVerdict {
        let step = try XCTUnwrap(KeySteps.split(KeyParse.sequence(spec).get()).first)
        return DeliveryProof.keys(target: 7, step: step, ref: (nil, nil), focus: (before, after), content: content, pixels: nil)
    }
    private func text(_ value: String, at: Int, _ length: Int = 0, id: String = "AXTextArea#1") -> ElementReading {
        .text(window: 7, identity: id, value: value, selection: (at, length))
    }

    /// A key that landed in text is not called unverified because it isn't a window's (r2 first-F1, second-S1).
    func testKeysThatEditOrMoveInTextAreVerifiedByIt() throws {
        for (key, before, after) in [("cmd+z", text("ab", at: 2), text("a", at: 1)), ("cmd+delete", text("ab", at: 2), text("", at: 0)),
                                     ("ctrl+a", text("ab", at: 2), text("ab", at: 0)), ("Tab", text("a", at: 1), text("a\t", at: 2)),
                                     ("Escape", text("ab", at: 2), text("", at: 0)), ("Return", text("ab", at: 2), text("", at: 0, id: "AXTextField#2"))] {
            XCTAssertTrue(try judge(key, before, after).verified, key)
        }
        for key in ["Return", "Escape", "PageDown", "End"] { XCTAssertTrue(try judge(key, text("ab", at: 2), text("ab", at: 2), content: true).verified, key) }
        for key in ["cmd+z", "Tab", "Escape", "x"] { XCTAssertFalse(try judge(key, text("ab", at: 2), text("ab", at: 2)).verified, key) }
    }

    /// Typed text proves itself where it went in, never by text already there (r2 sol-F2).
    func testTypedTextMustAppearWhereTheSelectionWas() throws {
        XCTAssertFalse(try judge("a b", text("ab", at: 2), text("aba", at: 3)).verified)
        XCTAssertFalse(try judge("a a", text("aab", at: 0), text("aaab", at: 1)).verified)
        XCTAssertTrue(try judge("a b", text("ab", at: 2), text("abab", at: 4)).verified)
        XCTAssertTrue(try judge("x", text("abc", at: 1, 1), text("axc", at: 2)).verified)
        let bare: (String) -> ElementReading = { .text(window: 7, identity: "AXTextArea#1", value: $0) }
        XCTAssertFalse(try judge("a b", bare("ab"), bare("aba")).verified)
        XCTAssertTrue(try judge("a b", bare(""), bare("ab")).verified)
    }

    /// A crop that can't be made sends no picture (r2 sol-F4).
    func testAZoomOutsideTheCaptureSendsNoImage() throws {
        let ctx = try XCTUnwrap(CGContext(data: nil, width: 20, height: 10, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        let data = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil))
        CGImageDestinationAddImage(dest, try XCTUnwrap(ctx.makeImage()), nil)
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        let mcp = HandsMCP(version: "1", session: "s", perform: { _ in .success(.object([:])) }, readImage: { _ in data as Data })
        let hash = SHA256.hash(data: data as Data).map { String(format: "%02x", $0) }.joined()
        func types(zoom: String, sha256: String? = nil) -> [String] {
            let shot = JSONValue.object(["path": "/x.png", "points": ShotImage.pointsJSON(CGSize(width: 20, height: 10)),
                                         "evidence": .object(["sha256": .string(sha256 ?? hash)])])
            return (mcp.imageParts(verb: "shot", arguments: ["zoom": .string(zoom)], data: shot) ?? []).compactMap { $0["type"]?.string }
        }
        XCTAssertEqual(types(zoom: "0,0,10,10"), ["text", "image"])
        XCTAssertEqual(types(zoom: "40,0,10,10"), ["text"])
        // Another capture replaced the file under this name: its picture isn't this window's (r2 sol-F3).
        XCTAssertEqual(types(zoom: "0,0,10,10", sha256: String(repeating: "0", count: 64)), ["text"])
    }
}
