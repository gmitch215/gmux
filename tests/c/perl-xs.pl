use strict;
use warnings;
use POSIX qw(floor ceil fmod strftime strtol INT_MAX);
use Socket qw(inet_aton inet_ntoa pack_sockaddr_in unpack_sockaddr_in AF_INET SOCK_STREAM);
use Fcntl qw(:DEFAULT :flock);
use File::Glob qw(bsd_glob);
use Data::Dumper;
use List::Util qw(sum max min first reduce);
use Digest::MD5 qw(md5_hex);
use Digest::SHA qw(sha256_hex);
use MIME::Base64 qw(encode_base64);
use Storable qw(freeze thaw);
use Encode qw(encode decode);
use Time::HiRes qw(time);
use Compress::Raw::Zlib;
use Cwd qw(getcwd);

$Data::Dumper::Sortkeys = 1;
$Data::Dumper::Indent = 1;

print "posix ", floor(-3.5), " ", ceil(3.2), " ", fmod(10, 3), " ", INT_MAX, "\n";
print "strftime ", strftime('%Y-%m-%d %H:%M:%S', gmtime(86400 * 365)), "\n";
print "strtol ", join(',', strtol('0x1f', 16)), "\n";
print "socket ", inet_ntoa(inet_aton('127.0.0.1')), " ", AF_INET, " ", SOCK_STREAM, "\n";
my ($port, $addr) = unpack_sockaddr_in(pack_sockaddr_in(8080, inet_aton('10.1.2.3')));
print "sockaddr $port ", inet_ntoa($addr), "\n";
print "fcntl ", O_RDONLY, " ", O_WRONLY, " ", O_CREAT, " ", O_EXCL, " ", LOCK_EX, "\n";
(my $dir = $INC{'Data/Dumper.pm'}) =~ s{/[^/]*$}{};
print 'glob ', join(' ', map { s{.*/}{}r } bsd_glob("$dir/Dumper.p*")), "\n";
print Data::Dumper->Dump([{ b => [1, 2], a => 'x' }], ['v']);
print "list ", sum(1 .. 10), " ", max(3, 9, 4), " ", min(3, 9, 4), " ", first { $_ > 3 } (1 .. 9);
print " ", reduce { $a * $b } 1 .. 6;
print "\n";
print "md5 ", md5_hex('gmux'), "\n";
print "sha256 ", sha256_hex('gmux'), "\n";
print 'base64 ', encode_base64('hello, perl', '');
print "\n";
my $t = thaw(freeze({ n => [1, 2, 3] }));
print "storable @{$t->{n}}\n";
print 'encode ', length(encode('UTF-8', "\x{263a}")), ' ', length(decode('UTF-8', "\xe2\x98\xba")), "\n";
print 'hires ', (time() =~ /^\d+(\.\d+)?$/ ? 'ok' : 'bad'), "\n";
my $in = 'a' x 1000;
my ($d) = Compress::Raw::Zlib::Deflate->new(-AppendOutput => 1);
my $out;
$d->deflate($in, $out);
$d->flush($out);
my ($i) = Compress::Raw::Zlib::Inflate->new();
my $back;
$i->inflate($out, $back);
print 'zlib ', $back eq $in ? 'same' : 'differs', ' ', Compress::Raw::Zlib::crc32($in), ' ', Compress::Raw::Zlib::adler32($in), "\n";
my @mods = qw(
	attributes B Compress::Raw::Bzip2 Cwd Devel::Peek Encode::Byte Encode::CN Encode::EBCDIC
	Encode::JP Encode::KR Encode::Symbol Encode::TW Encode::Unicode File::DosGlob
	Filter::Util::Call Hash::Util::FieldHash Hash::Util I18N::Langinfo IO IPC::SysV
	Math::BigInt::FastCalc mro Opcode PerlIO::encoding PerlIO::mmap PerlIO::via re SDBM_File
	Sys::Hostname Sys::Syslog threads::shared Time::Piece Unicode::Collate
	Unicode::Normalize
);
my %bad;
eval "require $_; 1" or $bad{$_} = (split /\n/, $@)[0] for @mods;
print 'modules ', @mods - keys %bad, ' of ', scalar(@mods), "\n";
print "failed $_: $bad{$_}\n" for sort keys %bad;
print "done\n";
