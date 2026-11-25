V8 9.36 ms per 2 units; plan-time sI 0.838 ns, sN 0.039 ns per instruction (each repeat is priced with its own ends), tau 255.0 ns; 2 repeats
| policy | budget | functions | code bytes | predicted r | measured r (spread) | error | predicted crossings | measured crossings | predicted boundary ms | measured boundary ms | crossing bytes | rung |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| hottest | 1 | 150 | 145988 | 1.09 | 1.10 (0%) | -0.8% | 0 | 0 | 0.00 | 0.12 | 0 | hottest@1 |
| closure | 1 | 150 | 145988 | 1.09 | 1.10 (0%) | -0.8% | 0 | 0 | 0.00 | 0.12 | 0 | hottest@1 |
| scc | 1 | 150 | 145988 | 1.09 | 1.10 (0%) | -0.8% | 0 | 0 | 0.00 | 0.12 | 0 | hottest@1 |
| mincut | 1 | 150 | 145988 | 1.09 | 1.10 (0%) | -0.8% | 0 | 0 | 0.00 | 0.12 | 0 | hottest@1 |
| hottest | 0.1 | 31 | 39352 | 1.92 | 1.75 (3%) | 9.3% | 47 | 47 | 0.01 | -0.75 | 1324 | hottest@0.1 |
| closure | 0.1 | 31 | 39144 | 5.79 | 5.92 (4%) | -2.3% | 39 | 39 | 0.01 | 0.64 | 748 | closure@0.1 |
| scc | 0.1 | 31 | 39352 | 1.92 | 1.75 (3%) | 9.3% | 47 | 47 | 0.01 | -0.75 | 1324 | hottest@0.1 |
| mincut | 0.1 | 33 | 37834 | 1.91 | 1.72 (3%) | 11.0% | 59 | 59 | 0.02 | -0.87 | 1660 | mincut@0.1 |
| hottest | 0.03 | 11 | 11800 | 6.93 | 7.26 (2%) | -4.6% | 58918 | 58918 | 15.03 | 16.58 | 1414180 | hottest@0.03 |
| closure | 0.03 | 19 | 11024 | 9.86 | 10.87 (1%) | -9.2% | 58914 | 58914 | 15.03 | 19.75 | 1413992 | closure@0.03 |
| scc | 0.03 | 11 | 11800 | 6.93 | 7.26 (2%) | -4.6% | 58918 | 58918 | 15.03 | 16.58 | 1414180 | hottest@0.03 |
| mincut | 0.03 | 11 | 11800 | 6.93 | 7.26 (2%) | -4.6% | 58918 | 58918 | 15.03 | 16.58 | 1414180 | hottest@0.03 |
| hottest | 0.015 | 8 | 5876 | 8.86 | 9.34 (4%) | -5.2% | 58913 | 58913 | 15.02 | 17.30 | 1413928 | hottest@0.015 |
| closure | 0.015 | 12 | 5767 | 10.21 | 11.30 (4%) | -9.6% | 58911 | 58911 | 15.02 | 20.12 | 1413884 | closure@0.015 |
| scc | 0.015 | 8 | 5876 | 8.86 | 9.34 (4%) | -5.2% | 58913 | 58913 | 15.02 | 17.30 | 1413928 | hottest@0.015 |
| mincut | 0.015 | 8 | 5814 | 8.86 | 9.83 (8%) | -9.9% | 58912 | 58912 | 15.02 | 19.56 | 1413908 | mincut@0.015 |

ends: interpreted r 22.89 (2%), native r 1.09 (2%)
tau fitted on the measured boundary residuals of the 5 sets with 1,000 or more crossings a unit: 316.8 ns
