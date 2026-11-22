#if os(iOS)
import SwiftUI

/// "Are you still watching?" — shown at EOF when the autoplay episode cap is
/// reached (mirror of the JS ContinueWatchingOverlay). Continue advances and
/// resets the chain counter JS-side; Go back closes the player. Modal by
/// design: the scrim swallows taps so the chrome can't be toggled beneath it.
struct StillWatchingOverlay: View {
	@ObservedObject var viewModel: PlayerViewModel

	var body: some View {
		ZStack {
			Colors.black80
				.ignoresSafeArea()
				.onTapGesture {}

			VStack(spacing: 14) {
				Text(viewModel.str("stillWatching", "Are you still watching?"))
					.font(.title2.weight(.bold))
					.foregroundStyle(Colors.white)
					.multilineTextAlignment(.center)
					.padding(.bottom, 10)

				Button {
					viewModel.continueWatchingTapped()
				} label: {
					Text(viewModel.str("continueWatching", "Continue watching"))
						.font(.headline)
						.foregroundStyle(Colors.black)
						.frame(maxWidth: .infinity)
						.padding(.vertical, 13)
						.background(Colors.white, in: Capsule())
				}

				Button {
					viewModel.stillWatchingCloseTapped()
				} label: {
					Text(viewModel.str("goBack", "Go back"))
						.font(.headline)
						.foregroundStyle(Colors.white80)
						.frame(maxWidth: .infinity)
						.padding(.vertical, 13)
				}
			}
			.frame(maxWidth: 320)
			.padding(.horizontal, 24)
		}
	}
}
#endif
