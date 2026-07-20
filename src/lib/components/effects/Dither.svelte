<script lang="ts" module>
	import { Effect, EffectComposer, EffectPass, RenderPass } from 'postprocessing';
	import * as THREE from 'three';

	type Color = [number, number, number];

	type WaveUniforms = Record<string, THREE.IUniform> & {
		time: THREE.Uniform<number>;
		resolution: THREE.Uniform<THREE.Vector2>;
		waveSpeed: THREE.Uniform<number>;
		waveFrequency: THREE.Uniform<number>;
		waveAmplitude: THREE.Uniform<number>;
		waveColor: THREE.Uniform<THREE.Color>;
		backgroundColor: THREE.Uniform<THREE.Color>;
		mousePos: THREE.Uniform<THREE.Vector2>;
		enableMouseInteraction: THREE.Uniform<number>;
		mouseRadius: THREE.Uniform<number>;
	};

	const waveVertexShader = `
		precision highp float;
		varying vec2 vUv;

		void main() {
			vUv = uv;
			vec4 modelPosition = modelMatrix * vec4(position, 1.0);
			vec4 viewPosition = viewMatrix * modelPosition;
			gl_Position = projectionMatrix * viewPosition;
		}
	`;

	const waveFragmentShader = `
		precision highp float;
		uniform vec2 resolution;
		uniform float time;
		uniform float waveSpeed;
		uniform float waveFrequency;
		uniform float waveAmplitude;
		uniform vec3 waveColor;
		uniform vec3 backgroundColor;
		uniform vec2 mousePos;
		uniform int enableMouseInteraction;
		uniform float mouseRadius;

		vec4 mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
		vec4 permute(vec4 x) { return mod289(((x * 34.0) + 1.0) * x); }
		vec4 taylorInvSqrt(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
		vec2 fade(vec2 t) { return t * t * t * (t * (t * 6.0 - 15.0) + 10.0); }

		float cnoise(vec2 p) {
			vec4 pi = floor(p.xyxy) + vec4(0.0, 0.0, 1.0, 1.0);
			vec4 pf = fract(p.xyxy) - vec4(0.0, 0.0, 1.0, 1.0);
			pi = mod289(pi);
			vec4 ix = pi.xzxz;
			vec4 iy = pi.yyww;
			vec4 fx = pf.xzxz;
			vec4 fy = pf.yyww;
			vec4 i = permute(permute(ix) + iy);
			vec4 gx = fract(i * (1.0 / 41.0)) * 2.0 - 1.0;
			vec4 gy = abs(gx) - 0.5;
			vec4 tx = floor(gx + 0.5);
			gx -= tx;
			vec2 g00 = vec2(gx.x, gy.x);
			vec2 g10 = vec2(gx.y, gy.y);
			vec2 g01 = vec2(gx.z, gy.z);
			vec2 g11 = vec2(gx.w, gy.w);
			vec4 norm = taylorInvSqrt(vec4(
				dot(g00, g00),
				dot(g01, g01),
				dot(g10, g10),
				dot(g11, g11)
			));
			g00 *= norm.x;
			g01 *= norm.y;
			g10 *= norm.z;
			g11 *= norm.w;
			float n00 = dot(g00, vec2(fx.x, fy.x));
			float n10 = dot(g10, vec2(fx.y, fy.y));
			float n01 = dot(g01, vec2(fx.z, fy.z));
			float n11 = dot(g11, vec2(fx.w, fy.w));
			vec2 fadeXY = fade(pf.xy);
			vec2 nx = mix(vec2(n00, n01), vec2(n10, n11), fadeXY.x);
			return 2.3 * mix(nx.x, nx.y, fadeXY.y);
		}

		const int OCTAVES = 4;

		float fbm(vec2 p) {
			float value = 0.0;
			float amplitude = 1.0;
			float frequency = waveFrequency;

			for (int i = 0; i < OCTAVES; i++) {
				value += amplitude * abs(cnoise(p));
				p *= frequency;
				amplitude *= waveAmplitude;
			}

			return value;
		}

		float pattern(vec2 p) {
			vec2 p2 = p - time * waveSpeed;
			return fbm(p + fbm(p2));
		}

		void main() {
			vec2 uv = gl_FragCoord.xy / resolution.xy;
			uv -= 0.5;
			uv.x *= resolution.x / resolution.y;
			float f = pattern(uv);

			if (enableMouseInteraction == 1) {
				vec2 mouseNdc = (mousePos / resolution - 0.5) * vec2(1.0, -1.0);
				mouseNdc.x *= resolution.x / resolution.y;
				float distanceToMouse = length(uv - mouseNdc);
				float mouseEffect = 1.0 - smoothstep(0.0, mouseRadius, distanceToMouse);
				f -= 0.5 * mouseEffect;
			}

			vec3 color = mix(backgroundColor, waveColor, f);
			gl_FragColor = vec4(color, 1.0);
		}
	`;

	const ditherFragmentShader = `
		precision highp float;
		uniform float colorNum;
		uniform float pixelSize;

		const float bayerMatrix8x8[64] = float[64](
			0.0/64.0, 48.0/64.0, 12.0/64.0, 60.0/64.0, 3.0/64.0, 51.0/64.0, 15.0/64.0, 63.0/64.0,
			32.0/64.0, 16.0/64.0, 44.0/64.0, 28.0/64.0, 35.0/64.0, 19.0/64.0, 47.0/64.0, 31.0/64.0,
			8.0/64.0, 56.0/64.0, 4.0/64.0, 52.0/64.0, 11.0/64.0, 59.0/64.0, 7.0/64.0, 55.0/64.0,
			40.0/64.0, 24.0/64.0, 36.0/64.0, 20.0/64.0, 43.0/64.0, 27.0/64.0, 39.0/64.0, 23.0/64.0,
			2.0/64.0, 50.0/64.0, 14.0/64.0, 62.0/64.0, 1.0/64.0, 49.0/64.0, 13.0/64.0, 61.0/64.0,
			34.0/64.0, 18.0/64.0, 46.0/64.0, 30.0/64.0, 33.0/64.0, 17.0/64.0, 45.0/64.0, 29.0/64.0,
			10.0/64.0, 58.0/64.0, 6.0/64.0, 54.0/64.0, 9.0/64.0, 57.0/64.0, 5.0/64.0, 53.0/64.0,
			42.0/64.0, 26.0/64.0, 38.0/64.0, 22.0/64.0, 41.0/64.0, 25.0/64.0, 37.0/64.0, 21.0/64.0
		);

		vec3 dither(vec2 uv, vec3 color) {
			vec2 scaledCoord = floor(uv * resolution / pixelSize);
			int x = int(mod(scaledCoord.x, 8.0));
			int y = int(mod(scaledCoord.y, 8.0));
			float threshold = bayerMatrix8x8[y * 8 + x] - 0.25;
			float colorStep = 1.0 / (colorNum - 1.0);
			color += threshold * colorStep;
			color = clamp(color - 0.2, 0.0, 1.0);
			return floor(color * (colorNum - 1.0) + 0.5) / (colorNum - 1.0);
		}

		void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
			vec2 normalizedPixelSize = pixelSize / resolution;
			vec2 pixelUv = normalizedPixelSize * floor(uv / normalizedPixelSize);
			vec4 color = texture2D(inputBuffer, pixelUv);
			color.rgb = dither(uv, color.rgb);
			outputColor = color;
		}
	`;

	class RetroEffect extends Effect {
		readonly colorNumUniform: THREE.Uniform<number>;
		readonly pixelSizeUniform: THREE.Uniform<number>;

		constructor() {
			const colorNumUniform = new THREE.Uniform(4);
			const pixelSizeUniform = new THREE.Uniform(2);

			super('RetroEffect', ditherFragmentShader, {
				uniforms: new Map([
					['colorNum', colorNumUniform],
					['pixelSize', pixelSizeUniform]
				])
			});

			this.colorNumUniform = colorNumUniform;
			this.pixelSizeUniform = pixelSizeUniform;
		}
	}

	function createWaveUniforms(): WaveUniforms {
		return {
			time: new THREE.Uniform(0),
			resolution: new THREE.Uniform(new THREE.Vector2(1, 1)),
			waveSpeed: new THREE.Uniform(0.05),
			waveFrequency: new THREE.Uniform(3),
			waveAmplitude: new THREE.Uniform(0.3),
			waveColor: new THREE.Uniform(new THREE.Color(0.5, 0.5, 0.5)),
			backgroundColor: new THREE.Uniform(new THREE.Color(0, 0, 0)),
			mousePos: new THREE.Uniform(new THREE.Vector2()),
			enableMouseInteraction: new THREE.Uniform(1),
			mouseRadius: new THREE.Uniform(1)
		};
	}
</script>

<script lang="ts">
	import type { Attachment } from 'svelte/attachments';

	type Props = {
		waveSpeed?: number;
		waveFrequency?: number;
		waveAmplitude?: number;
		waveColor?: Color;
		backgroundColor?: Color;
		colorNum?: number;
		pixelSize?: number;
		disableAnimation?: boolean;
		enableMouseInteraction?: boolean;
		mouseRadius?: number;
		class?: string;
	};

	let {
		waveSpeed = 0.05,
		waveFrequency = 3,
		waveAmplitude = 0.3,
		waveColor = [0.5, 0.5, 0.5],
		backgroundColor = [0, 0, 0],
		colorNum = 4,
		pixelSize = 2,
		disableAnimation = false,
		enableMouseInteraction = true,
		mouseRadius = 1,
		class: className = ''
	}: Props = $props();

	// Props are only read inside handlers, rAF callbacks and the nested
	// $effect below, so the attachment itself never re-runs: the WebGL
	// context is created exactly once per mount.
	const setupDither: Attachment<HTMLCanvasElement> = (canvas) => {
		const container = canvas.parentElement;
		if (!container) return;

		// The output is pixelated/dithered and the composer renders into its
		// own buffers, so MSAA, depth and stencil on the drawing buffer are
		// pure overhead.
		const renderer = new THREE.WebGLRenderer({
			canvas,
			antialias: false,
			depth: false,
			stencil: false,
			powerPreference: 'high-performance'
		});
		renderer.setPixelRatio(1);

		const scene = new THREE.Scene();
		const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
		camera.position.z = 1;

		const uniforms = createWaveUniforms();
		const geometry = new THREE.PlaneGeometry(2, 2);
		const material = new THREE.ShaderMaterial({
			vertexShader: waveVertexShader,
			fragmentShader: waveFragmentShader,
			uniforms,
			depthTest: false,
			depthWrite: false
		});
		const mesh = new THREE.Mesh(geometry, material);
		scene.add(mesh);

		const effect = new RetroEffect();
		const composer = new EffectComposer(renderer, {
			depthBuffer: false,
			stencilBuffer: false
		});
		composer.addPass(new RenderPass(scene, camera));
		composer.addPass(new EffectPass(camera, effect));

		let needsRender = true;

		const resize = () => {
			const { width: rawWidth, height: rawHeight } = container.getBoundingClientRect();
			const width = Math.max(1, Math.floor(rawWidth));
			const height = Math.max(1, Math.floor(rawHeight));

			renderer.setSize(width, height, false);
			composer.setSize(width, height);
			uniforms.resolution.value.set(canvas.width, canvas.height);
			needsRender = true;
		};

		const handlePointerMove = (event: PointerEvent) => {
			if (!enableMouseInteraction) return;

			const rect = canvas.getBoundingClientRect();
			uniforms.mousePos.value.set(event.clientX - rect.left, event.clientY - rect.top);
			needsRender = true;
		};

		// Sync props to uniforms only when they change instead of every frame.
		$effect(() => {
			uniforms.waveSpeed.value = waveSpeed;
			uniforms.waveFrequency.value = waveFrequency;
			uniforms.waveAmplitude.value = waveAmplitude;
			uniforms.waveColor.value.setRGB(waveColor[0], waveColor[1], waveColor[2]);
			uniforms.backgroundColor.value.setRGB(
				backgroundColor[0],
				backgroundColor[1],
				backgroundColor[2]
			);
			uniforms.enableMouseInteraction.value = enableMouseInteraction ? 1 : 0;
			uniforms.mouseRadius.value = mouseRadius;
			effect.colorNumUniform.value = Math.max(2, colorNum);
			effect.pixelSizeUniform.value = Math.max(1, pixelSize);
			needsRender = true;
		});

		const clock = new THREE.Clock();
		let animationFrame = 0;
		let running = false;

		const frame = () => {
			animationFrame = requestAnimationFrame(frame);

			if (!disableAnimation) {
				uniforms.time.value += clock.getDelta();
				needsRender = true;
			}

			if (!needsRender) return;
			needsRender = false;
			composer.render();
		};

		const start = () => {
			if (running) return;
			running = true;
			clock.getDelta();
			animationFrame = requestAnimationFrame(frame);
		};

		const stop = () => {
			if (!running) return;
			running = false;
			cancelAnimationFrame(animationFrame);
		};

		const resizeObserver = new ResizeObserver(resize);
		resizeObserver.observe(container);
		const intersectionObserver = new IntersectionObserver(([entry]) => {
			if (entry.isIntersecting) start();
			else stop();
		});
		intersectionObserver.observe(container);
		canvas.addEventListener('pointermove', handlePointerMove, { passive: true });
		resize();
		start();

		return () => {
			stop();
			resizeObserver.disconnect();
			intersectionObserver.disconnect();
			canvas.removeEventListener('pointermove', handlePointerMove);
			composer.dispose();
			effect.dispose();
			material.dispose();
			geometry.dispose();
			renderer.dispose();
		};
	};
</script>

<div class={`relative h-full w-full overflow-hidden ${className}`}>
	<canvas {@attach setupDither} class="block h-full w-full" aria-hidden="true"></canvas>
</div>
