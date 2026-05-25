"use client";

class SynthEngine {
  private ctx: AudioContext | null = null;

  public init() {
    if (typeof window === "undefined") return;
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
    }
    if (this.ctx.state === "suspended") {
      this.ctx.resume();
    }
  }

  public playGenerator() {
    if (!this.ctx) return;
    const osc = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    
    osc.type = "sawtooth";
    // Sweep up from 50Hz to 400Hz like a massive reactor/generator spinning up
    osc.frequency.setValueAtTime(50, this.ctx.currentTime);
    osc.frequency.exponentialRampToValueAtTime(400, this.ctx.currentTime + 1.5);
    
    // Fade in and out
    gain.gain.setValueAtTime(0.01, this.ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.15, this.ctx.currentTime + 1.0);
    gain.gain.exponentialRampToValueAtTime(0.01, this.ctx.currentTime + 2.0);
    
    // Filter to make it sound industrial, heavy, and sci-fi
    const filter = this.ctx.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(200, this.ctx.currentTime);
    filter.frequency.exponentialRampToValueAtTime(2000, this.ctx.currentTime + 1.5);
    
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(this.ctx.destination);
    
    osc.start();
    osc.stop(this.ctx.currentTime + 2.0);
  }
}

export const synth = new SynthEngine();
