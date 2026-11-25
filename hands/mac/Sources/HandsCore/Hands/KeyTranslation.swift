import CoreServices
import Foundation

/// What a key types, read from a keyboard layout's `uchr` data (a Text Input Source's Unicode key layout data). The
/// app's `KeyLayout` hands it the current layouts; tests hand it any layout's, so Dvorak and Russian are checked on
/// any Mac (198 r2 first-F2). Only translates; nothing is posted.
public enum KeyTranslation {
    /// UCKeyTranslate's modifier state is the Carbon modifier mask shifted right by 8: command (cmdKey, 1 << 8) is 1.
    public static let command: UInt32 = 1

    /// The characters `keyCode` types in each layout, plain, with command, and with the chord's own modifiers (`flags`,
    /// CGEventFlags bits) with and without command: the key that types ? is another one on a French layout. Each layout must be a Text Input
    /// Source's `kTISPropertyUnicodeKeyLayoutData`: UCKeyTranslate follows the table's own offsets, so any other bytes
    /// can send it past their end. Data too short for the header gives nothing; nothing longer is checked (214 r1 second-S3).
    public static func characters(_ keyCode: UInt16, flags: UInt64 = 0, layouts: [Data], keyboardType: UInt32) -> [Character] {
        // The Carbon mask shifted as `command` is: shift 2, option 8, control 16.
        var held: UInt32 = 0
        if flags & KeyChord.shift != 0 { held |= 2 }
        if flags & KeyChord.option != 0 { held |= 8 }
        if flags & KeyChord.control != 0 { held |= 16 }
        return layouts.flatMap { layout in Set([0, command, held, held | command]).compactMap { character(keyCode, modifiers: $0, layout: layout, keyboardType: keyboardType) } }
    }

    static func character(_ keyCode: UInt16, modifiers: UInt32, layout data: Data, keyboardType: UInt32) -> Character? {
        data.withUnsafeBytes { bytes -> Character? in
            guard bytes.count >= MemoryLayout<UCKeyboardLayout>.size,   // too short for a header; not a validation
                  let layout = bytes.baseAddress?.assumingMemoryBound(to: UCKeyboardLayout.self) else { return nil }
            var dead: UInt32 = 0, length = 0
            var chars = [UniChar](repeating: 0, count: 4)
            let status = UCKeyTranslate(layout, keyCode, UInt16(kUCKeyActionDown), modifiers, keyboardType,
                                        OptionBits(kUCKeyTranslateNoDeadKeysMask), &dead, chars.count, &length, &chars)
            guard status == noErr, length > 0 else { return nil }
            return String(utf16CodeUnits: chars, count: length).first
        }
    }
}
