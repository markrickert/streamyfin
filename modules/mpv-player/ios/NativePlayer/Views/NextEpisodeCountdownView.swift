#if os(iOS)
import SwiftUI

/// Next-episode countdown card shown during the outro: thumbnail, titles, a
/// countdown ring on the play button, and a dismiss (X) that stays canceled
/// until the next stream load.
struct NextEpisodeCountdownView: View {
	@ObservedObject var viewModel: PlayerViewModel
	let next: NextEpisodeRecord
	let remaining: Double

	var body: some View {
		HStack(spacing: 12) {
			thumbnail

			VStack(alignment: .leading, spacing: 2) {
				if let subtitle = next.subtitle {
					Text(subtitle)
						.font(.caption2)
						.foregroundStyle(Colors.white80)
						.lineLimit(1)
				}
				Text(next.title)
					.font(.footnote.weight(.semibold))
					.foregroundStyle(Colors.white)
					.lineLimit(2)
			}
			.frame(maxWidth: 160, alignment: .leading)

			Button {
				viewModel.playNextEpisode()
			} label: {
				ZStack {
					Circle()
						.stroke(Colors.white30, lineWidth: 3)
					Circle()
						.trim(from: 0, to: countdownFraction)
						.stroke(Colors.white, style: StrokeStyle(lineWidth: 3, lineCap: .round))
						.rotationEffect(.degrees(-90))
						.animation(.linear(duration: 1), value: remaining)
					Image(systemName: "play.fill")
						.font(.system(size: 16, weight: .bold))
						.foregroundStyle(Colors.white)
				}
				.frame(width: 44, height: 44)
			}
			.accessibilityLabel(viewModel.str("playNow", "Play now"))

			Button {
				viewModel.cancelCountdown()
			} label: {
				Image(systemName: "xmark")
					.font(.system(size: 14, weight: .semibold))
					.foregroundStyle(Colors.white80)
					.frame(width: 36, height: 36)
					.contentShape(Rectangle())
			}
			.accessibilityLabel(viewModel.str("cancel", "Cancel"))
		}
		.padding(12)
		.background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 16))
		.overlay(RoundedRectangle(cornerRadius: 16).stroke(Colors.white20, lineWidth: 1))
	}

	private var countdownFraction: CGFloat {
		guard next.countdownSeconds > 0 else { return 0 }
		return CGFloat(min(max(remaining / next.countdownSeconds, 0), 1))
	}

	@ViewBuilder
	private var thumbnail: some View {
		if let imageUrl = next.imageUrl, let url = URL(string: imageUrl) {
			RemoteImage(url: url, headers: viewModel.imageHeaders) {
				Colors.black50
			}
			.frame(width: 92, height: 52)
			.clipShape(RoundedRectangle(cornerRadius: 8))
		}
	}
}
#endif
