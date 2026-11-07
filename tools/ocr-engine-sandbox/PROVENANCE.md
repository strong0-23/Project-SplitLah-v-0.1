# Challenger provenance and fixed configuration

This sandbox is separate from the application's default scanner. It runs browser inference locally and never calls a hosted OCR API.

- SDK: **`@paddleocr/paddleocr-js@0.4.2`**, Apache-2.0. The scoped package is identified by the [official browser deployment documentation](https://www.paddleocr.ai/latest/en/version3.x/inference_deployment/cross_platform/browser.html). It is different from similarly named third-party npm packages and from the hosted API SDK.
- Published source anchor: [`e5046169b225bcdfbe25d45b4e809ff0f1a69c2c`](https://github.com/PaddlePaddle/PaddleOCR/blob/e5046169b225bcdfbe25d45b4e809ff0f1a69c2c/paddleocr-js/packages/core/package.json), as reported by npm `gitHead`.
- npm tarball integrity: `sha512-vpwSaFVKcpTaRaNXIXL7R76lyvGjqQ8K17d7L/gsugQZYkNfwMR+yesAkLwzZtXmQVdMhVGtQmqBAQNkjvQ3EQ==`. Registry signature was present; no build attestation was returned. Official identity links and package integrity do not establish a reproducible-build attestation.
- Runtime pins: ONNX Runtime Web **1.22.0** (MIT), OpenCV.js package **4.10.0-release.1** (Apache-2.0), clipper-lib **6.4.2** (BSL), js-yaml **4.1.0** (MIT). The separate `package-lock.json` pins every transitive dependency. No application dependency is added or upgraded.
- Models: **PP-OCRv5_mobile_det** and **PP-OCRv5_mobile_rec**. Official [detection](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det) and [recognition](https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_rec) cards declare Apache-2.0 and English support. The [SDK's immutable asset table](https://github.com/PaddlePaddle/PaddleOCR/blob/e5046169b225bcdfbe25d45b4e809ff0f1a69c2c/paddleocr-js/packages/core/src/resources/model-asset.ts) supplies the official ONNX archives.

The model archive URLs are mutable rather than content-addressed. `prepare-assets.mjs` retains exact bytes and hashes locally and refuses to accept altered pinned files. Measured archive identities in this experiment:

| Model | Bytes | SHA-256 |
|---|---:|---|
| v5 mobile detection | 4,843,520 | `781056046c9ed77a15c94681605db6a0f62317c2e9cce6931c71da2478d4bc30` |
| v5 mobile recognition | 16,701,440 | `f7e792bc836f36e7ef895ad47c426d75b0b75b1650caa6d63fe9418441ffba8c` |

Configuration is explicit in `browser.ts`: English/v5 selection, named models, WASM provider, SIMD enabled, one thread, no SDK worker, batch size one. Prediction uses full original colour images and the SDK's normal geometry/recognition preparation. Detection side limits **960** and **1920** are the only experiment variable. Other settings remain fixed: maximum side 4000, thresholds 0.3/0.6, unclip 2, recognition threshold 0. No per-receipt settings or answer-based selection are used.

The original Tesseract pipeline retains its own automatic orientation, paper crop, adaptive lighting, fallback readings and targeted unknown-amount recovery. The sandbox imports that exact frozen working source, including the existing coordinator, rather than constructing a second Tesseract implementation. Both engines feed the exact frozen `parseReceiptText`; the Tesseract control retains its existing multi-reading coordinator as part of its working pipeline.

Paddle output passes through the separately tested geometry-only `adapter.ts`. It reorders/group boxes into lines using observed positions and shared skew, without rewriting text, normalising prices, recognising summary labels or filling fields. Raw boxes, indices, reconstructed lines and ambiguity diagnostics remain separate. Its unresolved grouping does not establish that the downstream parser's unflagged output is correct.

Single-thread WASM works without cross-origin isolation. Main-thread inference can block UI, and worker packaging is not validated by this experiment. Threaded WASM/WebGPU would need additional deployment validation; [ORT documentation](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html) covers runtime/build matching and threading. SDK initialization reports that document preprocessing and text-line orientation modules are unsupported/ignored. No automatic perspective correction or rotation parity with Python PaddleOCR is assumed.

The CDP runner permits only loopback GET/HEAD requests and pinned public assets. Worker asset transport is redirected to identical locally pinned bytes before startup because worker CDP targets do not implement Fetch interception. This changes asset delivery, not application recognition code or model settings. Receipt bytes enter browser memory over loopback CDP, not through a served data directory. All benchmark reports and source snapshots stay under the Git-ignored local directory. Model files are excluded from the production entry and are not committed.
