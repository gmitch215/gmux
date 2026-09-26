/* the lane kernels as plain loops, built for wasm SIMD and natively from this
 * one file */
#define N 256
#define DOT (1 << 24)
#define W 512

static float A[N * N], B[N * N], C[N * N];
static signed char x8[DOT], y8[DOT];
static float img[(W + 2) * (W + 2)], out[W * W];

void init(void) {
    for (int i = 0; i < N * N; i++) {
        A[i] = (float) (i % 17) / 16.0f;
        B[i] = (float) (i % 13) / 12.0f;
    }
    for (int i = 0; i < DOT; i++) {
        x8[i] = (signed char) (i * 7);
        y8[i] = (signed char) (i * 13 + 5);
    }
    for (int i = 0; i < (W + 2) * (W + 2); i++)
        img[i] = (float) (i % 29) / 28.0f;
}

/* FP32 matrix multiply, 2 N^3 operations a repetition */
float sgemm(int reps) {
    for (int r = 0; r < reps; r++)
        for (int i = 0; i < N; i++)
            for (int k = 0; k < N; k++) {
                float a = A[i * N + k];
                for (int j = 0; j < N; j++) C[i * N + j] += a * B[k * N + j];
            }
    return C[0] + C[N * N - 1];
}

/* the int8 dot product under a quantized matmul, 2 operations an element */
int dot8(int reps) {
    int s = 0;
    for (int r = 0; r < reps; r++)
        for (int i = 0; i < DOT; i++) s += x8[i] * y8[i];
    return s;
}

/* a 3x3 FP32 convolution, 18 operations a pixel */
float conv3(int reps) {
    static const float k[9] = {0.0625f, 0.125f,  0.0625f, 0.125f, 0.25f,
                               0.125f,  0.0625f, 0.125f,  0.0625f};
    for (int r = 0; r < reps; r++)
        for (int y = 0; y < W; y++)
            for (int x = 0; x < W; x++) {
                const float* p = &img[y * (W + 2) + x];
                out[y * W + x] = k[0] * p[0] + k[1] * p[1] + k[2] * p[2] +
                                 k[3] * p[W + 2] + k[4] * p[W + 3] +
                                 k[5] * p[W + 4] + k[6] * p[2 * W + 4] +
                                 k[7] * p[2 * W + 5] + k[8] * p[2 * W + 6];
            }
    return out[0] + out[W * W - 1];
}
