#!/usr/bin/perl
# timeit.pl <cpu> <sibling cpu> <command...>: runs the command and prints its wall and cpu seconds,
# the milliseconds the pinned core and its SMT sibling were busy beyond it, the load average before
# and after, and 1 when another process shared the core (busy beyond the run by more than 20 ms
# plus 3% of the wall, or its sibling for more than 10% of it)
use strict;
use warnings;
use Time::HiRes qw(time);

my ($cpu, $sib, @cmd) = @ARGV;

sub busy {
	my %b;
	open my $f, '<', '/proc/stat' or die;
	while (<$f>) {
		next unless /^cpu(\d+) (.*)/;
		my ($n, @v) = ($1, split ' ', $2);
		$b{$n} = ($v[0] + $v[1] + $v[2] + $v[5] + $v[6] + ($v[7] // 0)) * 10;
	}
	return \%b;
}

sub load {
	open my $f, '<', '/proc/loadavg' or die;
	my @l = split ' ', scalar <$f>;
	return $l[0];
}

my $l0 = load();
my $b0 = busy();
my $t0 = time;
system(@cmd);
my $wall = time - $t0;
my $b1 = busy();
my @c = times;
my $cpu_s = $c[2] + $c[3];
my $l1 = load();
my $core = $b1->{$cpu} - $b0->{$cpu} - $cpu_s * 1000;
my $sibling = $sib eq $cpu ? 0 : $b1->{$sib} - $b0->{$sib};
my $shared = $core > 20 + 30 * $wall || $sibling > 100 * $wall ? 1 : 0;
printf "%.3f\t%.3f\t%d\t%d\t%s\t%s\t%d\n", $wall, $cpu_s, $core, $sibling, $l0, $l1, $shared;
