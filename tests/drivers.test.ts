import { describe, expect, it } from 'vitest'
import {
  buildUiInputCommand,
  extractJpegFrames,
  parseHdcScreenSize,
  parseHdcTargets,
  parseWlanIp
} from '../src/main/drivers/hdc-utils'
import {
  ANDROID_KEY_ACTION_DOWN,
  ANDROID_MOTION_ACTION_DOWN,
  parseAdbDevices,
  serializeKeycodeEvent,
  serializeScrollEvent,
  serializeTextEvent,
  serializeTouchEvent
} from '../src/main/drivers/scrcpy-protocol'

describe('HarmonyOS NEXT HDC utils', () => {
  it('parses hdc list targets -v output and filters out UART COM ports', () => {
    const output = [
      '2LQ0224123000123\tUSB\tConnected\tlocalhost',
      '192.168.1.50:5555\tTCP\tConnected\tlocalhost',
      '3AB999\tUSB\tOffline\tlocalhost',
      'COM3\t\tUART\tReady\tunknown...\thdc',
      'COM8\t\tUART\tReady\tunknown...\thdc'
    ].join('\n')

    expect(parseHdcTargets(output)).toEqual([
      { id: '2LQ0224123000123', connection: 'usb', state: 'online' },
      { id: '192.168.1.50:5555', connection: 'wifi', state: 'online' },
      { id: '3AB999', connection: 'usb', state: 'offline' }
    ])
  })

  it('returns empty array for [Empty]', () => {
    expect(parseHdcTargets('[Empty]\n')).toEqual([])
  })

  it('parses RenderService screen resolution', () => {
    expect(parseHdcScreenSize('physical screen resolution: 1260x2720')).toEqual({
      width: 1260,
      height: 2720
    })
    expect(parseHdcScreenSize('activeMode: 1080×2340, refreshRate: 120')).toEqual({
      width: 1080,
      height: 2340
    })
  })

  it('parses wlan0 IPv4 address', () => {
    const ifconfig = 'wlan0     Link encap:Ethernet\n          inet addr:192.168.31.102  Bcast:192.168.31.255'
    expect(parseWlanIp(ifconfig)).toBe('192.168.31.102')
  })

  it('builds uitest uiInput commands with normalized coordinates', () => {
    expect(buildUiInputCommand({ type: 'click', nx: 0.5, ny: 0.5 }, 1001, 2001)).toBe(
      'uitest uiInput click 500 1000'
    )
    expect(buildUiInputCommand({ type: 'longClick', nx: 0.2, ny: 0.8 }, 1001, 2001)).toBe(
      'uitest uiInput longClick 200 1600'
    )
    expect(
      buildUiInputCommand({ type: 'swipe', nx1: 0.5, ny1: 0.8, nx2: 0.5, ny2: 0.2, speed: 2000 }, 1001, 2001)
    ).toBe('uitest uiInput swipe 500 1600 500 400 2000')
    expect(buildUiInputCommand({ type: 'key', action: 'back' }, 1000, 2000)).toBe(
      'uitest uiInput keyEvent Back'
    )
    expect(buildUiInputCommand({ type: 'text', text: 'hello "world"' }, 1000, 2000)).toBe(
      'uitest uiInput text "hello \\"world\\""'
    )
  })

  it('extracts multiple JPEG frames and keeps incomplete remainder', () => {
    const f1 = Buffer.from([0xff, 0xd8, 0x01, 0x02, 0xff, 0xd9])
    const f2 = Buffer.from([0xff, 0xd8, 0x03, 0x04, 0x05, 0xff, 0xd9])
    const partial = Buffer.from([0xff, 0xd8, 0xaa, 0xbb])
    const stream = Buffer.concat([Buffer.from([0x00, 0x11]), f1, f2, partial])

    const { frames, remainder } = extractJpegFrames(stream)
    expect(frames).toHaveLength(2)
    expect(frames[0].equals(f1)).toBe(true)
    expect(frames[1].equals(f2)).toBe(true)
    expect(remainder.equals(partial)).toBe(true)
  })
})

describe('Android ADB & scrcpy protocol', () => {
  it('parses adb devices -l output', () => {
    const out = [
      'List of devices attached',
      'R58N123456A            device product:gts8 model:SM_S9180 transport_id:1',
      '192.168.1.99:5555      unauthorized transport_id:2'
    ].join('\n')

    expect(parseAdbDevices(out)).toEqual([
      { id: 'R58N123456A', state: 'online', model: 'SM S9180', connection: 'usb' },
      { id: '192.168.1.99:5555', state: 'unauthorized', model: 'Android Device', connection: 'wifi' }
    ])
  })

  it('serializes scrcpy touch, keycode, text, and scroll packets with exact sizes', () => {
    const touch = serializeTouchEvent({
      action: ANDROID_MOTION_ACTION_DOWN,
      x: 540,
      y: 1200,
      width: 1080,
      height: 2400
    })
    expect(touch.length).toBe(32)
    expect(touch.readUInt8(0)).toBe(2)
    expect(touch.readInt32BE(10)).toBe(540)
    expect(touch.readInt32BE(14)).toBe(1200)

    const key = serializeKeycodeEvent(ANDROID_KEY_ACTION_DOWN, 4)
    expect(key.length).toBe(14)
    expect(key.readInt32BE(2)).toBe(4)

    const text = serializeTextEvent('Hi')
    expect(text.length).toBe(7)
    expect(text.readUInt32BE(1)).toBe(2)

    const scroll = serializeScrollEvent({
      x: 100,
      y: 200,
      width: 1080,
      height: 2400,
      hScroll: 0,
      vScroll: 0.5
    })
    expect(scroll.length).toBe(21)
  })
})
