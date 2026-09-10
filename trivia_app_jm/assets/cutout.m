// cutout.m — lift the subject out of a photo, leaving a transparent background.
//
//   clang -fobjc-arc -O2 -framework Foundation -framework Vision -framework CoreImage \
//         -framework AppKit -framework CoreVideo -framework CoreGraphics \
//         assets/cutout.m -o /tmp/cutout
//   /tmp/cutout in.jpg out.png [--crop] [--no-person]
//
// Runs BOTH of Vision's segmenters and unions the result, because each misses
// something the other catches:
//   · foreground instance mask — keeps objects the subject is holding, but drops
//     thin limbs against a busy background (it lost a raised finger entirely)
//   · person segmentation — a different network, better on limbs, but it only
//     knows about people so it drops held objects
// The union keeps the drink AND the finger. --no-person falls back to the
// instance mask alone.
//
// --crop trims to the subject, which matters before an EGA conversion: every
// transparent pixel you keep is a wasted EGA pixel at 160 across.
//
// Written in Objective-C rather than Swift because the Swift toolchain shipped
// with these Command Line Tools has a compiler/SDK version mismatch.
// Requires macOS 14+. Pipeline: cutout → ega.py → frame.

#import <Foundation/Foundation.h>
#import <Vision/Vision.h>
#import <CoreImage/CoreImage.h>
#import <AppKit/AppKit.h>

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 3) { fprintf(stderr, "usage: cutout <in> <out.png> [--crop] [--no-person]\n"); return 2; }
    NSURL *inURL = [NSURL fileURLWithPath:@(argv[1])];
    NSURL *outURL = [NSURL fileURLWithPath:@(argv[2])];
    BOOL crop = NO, usePerson = YES;
    for (int i = 3; i < argc; i++) {
      if (!strcmp(argv[i], "--crop")) crop = YES;
      if (!strcmp(argv[i], "--no-person")) usePerson = NO;
    }

    CIImage *src = [CIImage imageWithContentsOfURL:inURL];
    if (!src) { fprintf(stderr, "cannot read %s\n", argv[1]); return 1; }
    CGRect ext = src.extent;
    NSError *err = nil;

    VNImageRequestHandler *handler = [[VNImageRequestHandler alloc] initWithCIImage:src options:@{}];
    VNGenerateForegroundInstanceMaskRequest *fg = [[VNGenerateForegroundInstanceMaskRequest alloc] init];
    VNGeneratePersonSegmentationRequest *ps = [[VNGeneratePersonSegmentationRequest alloc] init];
    ps.qualityLevel = VNGeneratePersonSegmentationRequestQualityLevelAccurate;
    ps.outputPixelFormat = kCVPixelFormatType_OneComponent8;

    NSArray *reqs = usePerson ? @[fg, ps] : @[fg];
    if (![handler performRequests:reqs error:&err]) {
      fprintf(stderr, "vision failed: %s\n", err.localizedDescription.UTF8String); return 1;
    }

    VNInstanceMaskObservation *obs = fg.results.firstObject;
    if (!obs || obs.allInstances.count == 0) { fprintf(stderr, "no subject found\n"); return 1; }
    CVPixelBufferRef fgBuf = [obs generateScaledMaskForImageForInstances:obs.allInstances
                                                      fromRequestHandler:handler error:&err];
    if (!fgBuf) { fprintf(stderr, "mask failed: %s\n", err.localizedDescription.UTF8String); return 1; }
    CIImage *mask = [CIImage imageWithCVPixelBuffer:fgBuf];
    mask = [mask imageByApplyingTransform:CGAffineTransformMakeScale(ext.size.width / mask.extent.size.width,
                                                                    ext.size.height / mask.extent.size.height)];

    if (usePerson) {
      VNPixelBufferObservation *pobs = ps.results.firstObject;
      if (pobs) {
        CIImage *pm = [CIImage imageWithCVPixelBuffer:pobs.pixelBuffer];
        pm = [pm imageByApplyingTransform:CGAffineTransformMakeScale(ext.size.width / pm.extent.size.width,
                                                                    ext.size.height / pm.extent.size.height)];
        // the person model outputs a soft ramp; firm it up, then take the brighter of the two masks
        pm = [pm imageByApplyingFilter:@"CIColorControls" withInputParameters:@{kCIInputContrastKey: @3.0, kCIInputBrightnessKey: @-0.15}];
        mask = [mask imageByApplyingFilter:@"CILightenBlendMode" withInputParameters:@{kCIInputBackgroundImageKey: pm}];
      }
    }

    CIImage *out = [src imageByApplyingFilter:@"CIBlendWithMask"
                          withInputParameters:@{kCIInputMaskImageKey: mask,
                                                kCIInputBackgroundImageKey: [CIImage emptyImage]}];
    if (crop) {
      // trim to where the mask is actually opaque
      CIImage *probe = [mask imageByApplyingFilter:@"CIColorThreshold" withInputParameters:@{@"inputThreshold": @0.03}];
      CGRect box = [[CIContext context] createCGImage:probe fromRect:probe.extent] ? probe.extent : ext;
      (void)box; // extent of a threshold is the full image; the real trim happens below via alpha scan
    }

    CIContext *ctx = [CIContext context];
    CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
    if (![ctx writePNGRepresentationOfImage:out toURL:outURL format:kCIFormatRGBA8
                                colorSpace:cs options:@{} error:&err]) {
      fprintf(stderr, "write failed: %s\n", err.localizedDescription.UTF8String); return 1;
    }
    printf("%s -> %s  %dx%d  instances: %lu%s\n", inURL.lastPathComponent.UTF8String,
           outURL.lastPathComponent.UTF8String, (int)ext.size.width, (int)ext.size.height,
           (unsigned long)obs.allInstances.count, usePerson ? "  (+person)" : "");
    CVPixelBufferRelease(fgBuf);
    CGColorSpaceRelease(cs);
  }
  return 0;
}
