class PcmResamplerProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();
        const processorOptions = options.processorOptions || {};
        this.targetSampleRate = processorOptions.targetSampleRate || 16000;
        this.frameSamples = processorOptions.frameSamples || 1600;
        this.phase = 0;
        this.accumulator = 0;
        this.accumulatorCount = 0;
        this.outputFrame = new Int16Array(this.frameSamples);
        this.outputIndex = 0;
        this.levelSampleCount = 0;
        this.levelSquareSum = 0;
        this.levelPeak = 0;
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || input.length === 0 || input[0].length === 0) {
            return true;
        }

        const channelCount = input.length;
        const sampleCount = input[0].length;
        for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
            let monoSample = 0;
            for (let channelIndex = 0; channelIndex < channelCount; channelIndex += 1) {
                monoSample += input[channelIndex][sampleIndex] || 0;
            }
            monoSample /= channelCount;
            this.levelSampleCount += 1;
            this.levelSquareSum += monoSample * monoSample;
            this.levelPeak = Math.max(this.levelPeak, Math.abs(monoSample));

            this.accumulator += monoSample;
            this.accumulatorCount += 1;
            this.phase += this.targetSampleRate;

            if (this.phase >= sampleRate) {
                const averagedSample = this.accumulator / this.accumulatorCount;
                this.writeSample(averagedSample);
                this.phase -= sampleRate;
                this.accumulator = 0;
                this.accumulatorCount = 0;
            }

            if (this.levelSampleCount >= sampleRate) {
                this.port.postMessage({
                    type: "AUDIO_LEVEL",
                    rms: Math.sqrt(this.levelSquareSum / this.levelSampleCount),
                    peak: this.levelPeak
                });
                this.levelSampleCount = 0;
                this.levelSquareSum = 0;
                this.levelPeak = 0;
            }
        }
        return true;
    }

    writeSample(floatSample) {
        const clamped = Math.max(-1, Math.min(1, floatSample));
        this.outputFrame[this.outputIndex] = clamped < 0
            ? Math.round(clamped * 32768)
            : Math.round(clamped * 32767);
        this.outputIndex += 1;

        if (this.outputIndex === this.frameSamples) {
            const completedFrame = this.outputFrame;
            this.outputFrame = new Int16Array(this.frameSamples);
            this.outputIndex = 0;
            this.port.postMessage(
                {
                    type: "PCM_FRAME",
                    buffer: completedFrame.buffer
                },
                [completedFrame.buffer]
            );
        }
    }
}

registerProcessor("pcm-resampler", PcmResamplerProcessor);
