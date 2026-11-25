V8 13.12 ms per 2 units; plan-time sI 1.122 ns, sN 0.053 ns per instruction (each repeat is priced with its own ends), tau 292.0 ns; 2 repeats
| policy | budget | functions | code bytes | predicted r | measured r (spread) | error | predicted crossings | measured crossings | predicted boundary ms | measured boundary ms | crossing bytes | rung |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hottest | 1 | 150 | 145988 | 1.08 | 1.27 (12%) | -15.0% | 0 | 0 | 0.00 | 1.58 | 0 | hottest@1 |
| closure | 1 | 150 | 145988 | 1.08 | 1.27 (12%) | -15.0% | 0 | 0 | 0.00 | 1.58 | 0 | hottest@1 |
| scc | 1 | 150 | 145988 | 1.08 | 1.27 (12%) | -15.0% | 0 | 0 | 0.00 | 1.58 | 0 | hottest@1 |
| mincut | 1 | 150 | 145988 | 1.08 | 1.27 (12%) | -15.0% | 0 | 0 | 0.00 | 1.58 | 0 | hottest@1 |
| hottest | 0.1 | 31 | 39352 | 1.92 | 1.76 (6%) | 8.9% | 47 | 47 | 0.01 | -1.02 | 1324 | hottest@0.1 |
| closure | 0.1 | 31 | 39144 | 6.07 | 6.11 (7%) | -0.7% | 39 | 39 | 0.01 | 0.30 | 748 | closure@0.1 |
| scc | 0.1 | 31 | 39352 | 1.92 | 1.76 (6%) | 8.9% | 47 | 47 | 0.01 | -1.02 | 1324 | hottest@0.1 |
| mincut | 0.1 | 34 | 38022 | 1.91 | 1.77 (7%) | 8.0% | 60 | 60 | 0.02 | -0.91 | 1680 | mincut@0.1 |
| hottest | 0.03 | 11 | 11800 | 6.46 | 7.44 (4%) | -13.1% | 58918 | 58918 | 17.20 | 23.60 | 1414180 | hottest@0.03 |
| closure | 0.03 | 19 | 11024 | 9.61 | 10.91 (2%) | -11.9% | 58914 | 58914 | 17.20 | 26.50 | 1413992 | closure@0.03 |
| scc | 0.03 | 11 | 11800 | 6.46 | 7.44 (4%) | -13.1% | 58918 | 58918 | 17.20 | 23.60 | 1414180 | hottest@0.03 |
| mincut | 0.03 | 11 | 11800 | 6.46 | 7.44 (4%) | -13.1% | 58918 | 58918 | 17.20 | 23.60 | 1414180 | hottest@0.03 |
| hottest | 0.015 | 8 | 5876 | 8.53 | 9.14 (5%) | -6.7% | 58913 | 58913 | 17.20 | 22.66 | 1413928 | hottest@0.015 |
| closure | 0.015 | 12 | 5767 | 9.99 | 10.77 (4%) | -7.3% | 58911 | 58911 | 17.20 | 24.46 | 1413884 | closure@0.015 |
| scc | 0.015 | 8 | 5876 | 8.53 | 9.14 (5%) | -6.7% | 58913 | 58913 | 17.20 | 22.66 | 1413928 | hottest@0.015 |
| mincut | 0.015 | 8 | 5814 | 8.53 | 8.89 (0%) | -4.0% | 58912 | 58912 | 17.20 | 21.02 | 1413908 | mincut@0.015 |

ends: interpreted r 24.40 (7%), native r 1.08 (5%)
tau fitted on the measured boundary residuals of the 5 sets with 1,000 or more crossings a unit: 401.4 ns
