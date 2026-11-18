//! `browser_screenshot`: the visible part of the browser page as an image,
//! taken by the engine itself (never by reading the screen, so nothing
//! outside the browser window is ever captured):
//! - macOS: `WKWebView takeSnapshotWithConfiguration:` -> JPEG.
//! - Windows: `ICoreWebView2::CapturePreview` -> JPEG.
//! - Linux: `webkit_web_view_get_snapshot` (visible region) -> PNG.
//!
//! The native call runs on the UI thread (`with_webview`); its completion
//! handler sends the bytes back over a oneshot channel.

use std::sync::{Arc, Mutex};

use tauri::WebviewWindow;

/// An encoded screenshot.
pub struct Shot {
    pub mime: &'static str,
    pub data: Vec<u8>,
}

type Reply = tokio::sync::oneshot::Sender<Result<Shot, String>>;

/// Single-use, cloneable answer channel usable from native callbacks (the
/// first answer wins, later ones are dropped).
pub type Responder = Arc<dyn Fn(Result<Shot, String>) + Send + Sync>;

fn once(sender: Reply) -> Responder {
    let slot = Mutex::new(Some(sender));
    Arc::new(move |result| {
        if let Some(sender) = slot.lock().ok().and_then(|mut slot| slot.take()) {
            let _ = sender.send(result);
        }
    })
}

/// Capture the visible page.
pub async fn capture(window: &WebviewWindow) -> Result<Shot, String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let send = once(sender);
    window
        .with_webview(move |webview| platform::capture(webview, send))
        .map_err(|_| "the browser window is closed".to_string())?;
    receiver
        .await
        .map_err(|_| "the screenshot was not delivered".to_string())?
}

#[cfg(target_os = "macos")]
mod platform {
    use super::Shot;
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2::runtime::AnyObject;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSImage, NSImageCompressionFactor,
    };
    use objc2_foundation::{NSDictionary, NSError, NSNumber};
    use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};

    /// Snapshot width in points (the image is this wide times the screen
    /// scale): enough to read a page, small enough for the model.
    const WIDTH_POINTS: f64 = 900.0;

    fn encode_jpeg(image: &NSImage) -> Result<Shot, String> {
        let tiff = image
            .TIFFRepresentation()
            .ok_or("the snapshot has no bitmap")?;
        let rep =
            NSBitmapImageRep::imageRepWithData(&tiff).ok_or("the snapshot is not a bitmap")?;
        let quality = NSNumber::new_f64(0.7);
        // SAFETY: the dictionary maps the documented property key to an
        // NSNumber, the type `representationUsingType:properties:` expects.
        let data = unsafe {
            let value: &AnyObject = &quality;
            let properties = NSDictionary::from_slices(&[NSImageCompressionFactor], &[value]);
            rep.representationUsingType_properties(NSBitmapImageFileType::JPEG, &properties)
        }
        .ok_or("the snapshot could not be encoded")?;
        Ok(Shot {
            mime: "image/jpeg",
            data: data.to_vec(),
        })
    }

    pub fn capture(webview: tauri::webview::PlatformWebview, send: super::Responder) {
        let Some(mtm) = MainThreadMarker::new() else {
            send(Err("the snapshot must start on the UI thread".into()));
            return;
        };
        // SAFETY: `inner()` is the live WKWebView of this window, and this
        // closure runs on the main thread (`with_webview`).
        unsafe {
            let webview: &WKWebView = &*(webview.inner() as *const WKWebView);
            let config = WKSnapshotConfiguration::new(mtm);
            config.setSnapshotWidth(Some(&NSNumber::new_f64(WIDTH_POINTS)));
            let handler = RcBlock::new(move |image: *mut NSImage, _error: *mut NSError| {
                let result = if image.is_null() {
                    Err("the page could not be captured".to_string())
                } else {
                    encode_jpeg(&*image)
                };
                send(result);
            });
            webview.takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::Shot;
    use webview2_com::CapturePreviewCompletedHandler;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG;
    use windows::Win32::System::Com::{IStream, STATFLAG_NONAME, STREAM_SEEK_SET};
    use windows::Win32::UI::Shell::SHCreateMemStream;

    fn read_all(stream: &IStream) -> windows::core::Result<Vec<u8>> {
        // SAFETY: plain COM calls on a stream this module created.
        unsafe {
            stream.Seek(0, STREAM_SEEK_SET, None)?;
            let mut stat = Default::default();
            stream.Stat(&mut stat, STATFLAG_NONAME)?;
            let size = usize::try_from(stat.cbSize).unwrap_or(0);
            let mut data = vec![0u8; size];
            let mut read_total = 0usize;
            while read_total < size {
                let mut read = 0u32;
                let chunk = &mut data[read_total..];
                stream
                    .Read(
                        chunk.as_mut_ptr().cast(),
                        u32::try_from(chunk.len()).unwrap_or(u32::MAX),
                        Some(&mut read),
                    )
                    .ok()?;
                if read == 0 {
                    break;
                }
                read_total += read as usize;
            }
            data.truncate(read_total);
            Ok(data)
        }
    }

    pub fn capture(webview: tauri::webview::PlatformWebview, send: super::Responder) {
        let started = (|| -> Result<(), String> {
            // SAFETY: COM calls on the live controller of this window, on
            // the UI thread (`with_webview`).
            unsafe {
                let core = webview
                    .controller()
                    .CoreWebView2()
                    .map_err(|_| "the browser engine is not ready".to_string())?;
                let stream = SHCreateMemStream(None).ok_or("no memory stream")?;
                let reader = stream.clone();
                let reply = send.clone();
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                    reply(
                        result
                            .and_then(|()| read_all(&reader))
                            .map(|data| Shot {
                                mime: "image/jpeg",
                                data,
                            })
                            .map_err(|_| "the page could not be captured".to_string()),
                    );
                    Ok(())
                }));
                core.CapturePreview(
                    COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG,
                    &stream,
                    &handler,
                )
                .map_err(|_| "the page could not be captured".to_string())
            }
        })();
        if let Err(message) = started {
            // The handler never ran: answer here instead.
            send(Err(message));
        }
    }
}

#[cfg(target_os = "linux")]
mod platform {
    use super::Shot;
    use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

    pub fn capture(webview: tauri::webview::PlatformWebview, send: super::Responder) {
        webview.inner().snapshot(
            SnapshotRegion::Visible,
            SnapshotOptions::NONE,
            None::<&webkit2gtk::gio::Cancellable>,
            move |result| {
                let encoded = result
                    .map_err(|_| "the page could not be captured".to_string())
                    .and_then(|surface| {
                        let image = cairo::ImageSurface::try_from(surface)
                            .map_err(|_| "the snapshot is not an image".to_string())?;
                        let mut data = Vec::new();
                        image
                            .write_to_png(&mut data)
                            .map_err(|_| "the snapshot could not be encoded".to_string())?;
                        Ok(Shot {
                            mime: "image/png",
                            data,
                        })
                    });
                send(encoded);
            },
        );
    }
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
mod platform {
    use super::Shot;

    pub fn capture(_webview: tauri::webview::PlatformWebview, send: super::Responder) {
        send(Err("screenshots are not available on this system".into()));
    }
}
